// ============================================================================
// ReadReceipts.js — Reads read receipt data from Instagram's Relay store
// Separate from ReactDev.js to avoid conflicts when diffing with Colddms
//
// This script runs in the PAGE CONTEXT (same as dom.js / ReactDev.js)
// It communicates with content.js via window.postMessage
//
// Data flow:
//   content.js → postMessage("readreceipts:request") → ReadReceipts.js
//   ReadReceipts.js → finds Relay store → extracts XFBSlideReadReceipt records
//   ReadReceipts.js → postMessage("readreceipts:response", data) → content.js
//
// Relay store schema (confirmed from real dump):
//   XFBSlideReadReceipt: { participant_fbid, watermark_timestamp_ms }
//   XFBIGDirectViewerThread: { thread_key, viewer_id, users, slide_read_receipts, is_group, ... }
//   XDTUserDict: { username, pk, id, interop_messaging_user_fbid, ... }
//   SlideMessage: { sender_fbid, timestamp_ms, thread_fbid, ... }
// ============================================================================

(function () {
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.type !== "readreceipts:request") return;

    try {
      const result = await extractReadReceipts();
      window.postMessage({ type: "readreceipts:response", data: result }, "*");
    } catch (e) {
      window.postMessage({ type: "readreceipts:response", data: [], error: e?.toString?.() }, "*");
    }
  });

  function findRootFiber() {
    for (const el of document.querySelectorAll("*")) {
      const keys = Object.keys(el);
      const fiberKey = keys.find(
        (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
      );
      if (fiberKey) {
        let fiber = el[fiberKey];
        if (fiber) {
          while (fiber.return) fiber = fiber.return;
          return fiber;
        }
      }
    }
    return null;
  }

  function findRelayEnv(rootFiber) {
    const queue = [rootFiber];
    const visited = new WeakSet();

    while (queue.length > 0) {
      const fiber = queue.shift();
      if (!fiber || visited.has(fiber)) continue;
      visited.add(fiber);

      try {
        const ctx = fiber.type?._context;
        if (ctx && ctx._currentValue) {
          const cv = ctx._currentValue;
          if (typeof cv.getStore === "function") return cv;
          if (cv.environment && typeof cv.environment.getStore === "function") return cv.environment;
        }
      } catch {}

      try {
        if (fiber.memoizedProps) {
          const props = fiber.memoizedProps;
          if (props.environment && typeof props.environment.getStore === "function") return props.environment;
        }
      } catch {}

      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  async function extractReadReceipts() {
    const rootFiber = findRootFiber();
    if (!rootFiber) return [];

    const relayEnv = findRelayEnv(rootFiber);
    if (!relayEnv) return [];

    let allRecords = null;
    try {
      const store = relayEnv.getStore();
      const source = store.getSource();
      if (typeof source.toJSON === "function") {
        allRecords = source.toJSON();
      } else if (source._records) {
        allRecords = source._records;
      }
    } catch (e) {
      return [];
    }

    if (!allRecords) return [];

    const threads = {};
    const receipts = {};
    const users = {};
    const messages = {};

    for (const [id, rec] of Object.entries(allRecords)) {
      if (!rec) continue;
      switch (rec.__typename) {
        case "XFBIGDirectViewerThread":
          threads[id] = rec;
          break;
        case "XFBSlideReadReceipt":
          receipts[id] = rec;
          break;
        case "XDTUserDict":
          users[id] = rec;
          break;
        case "SlideMessage":
          messages[id] = rec;
          break;
      }
    }

    const results = [];

    for (const [threadRelayId, thread] of Object.entries(threads)) {
      try {
        if (thread.is_group) continue;

        const threadKey = thread.thread_key;
        if (!threadKey) continue;

        const viewerId = thread.viewer_id;

        let otherUsername = null;

        if (thread.users && thread.users.__refs) {
          for (const ref of thread.users.__refs) {
            const user = users[ref];
            if (user && String(user.pk) !== String(viewerId)) {
              otherUsername = user.username;
              break;
            }
          }
        }

        if (!otherUsername) {
          if (thread.thread_title) otherUsername = thread.thread_title;
          else continue;
        }

        let otherPersonSeenAt = null;

        if (thread.slide_read_receipts && thread.slide_read_receipts.__refs) {
          for (const ref of thread.slide_read_receipts.__refs) {
            const receipt = receipts[ref];
            if (receipt && receipt.participant_fbid === threadKey) {
              otherPersonSeenAt = receipt.watermark_timestamp_ms;
              break;
            }
          }
        }

        let ourLastMessageTimestamp = 0;

        for (const [msgId, msg] of Object.entries(messages)) {
          if (msg.thread_fbid !== thread.id && msg.thread_fbid !== threadRelayId) continue;
          if (msg.sender_fbid !== threadKey) {
            const ts = Number(msg.timestamp_ms);
            if (ts > ourLastMessageTimestamp) ourLastMessageTimestamp = ts;
          }
        }

        let hasSeen = false;
        if (otherPersonSeenAt && ourLastMessageTimestamp > 0) {
          hasSeen = Number(otherPersonSeenAt) >= ourLastMessageTimestamp;
        }

        let hasReply = false;
        for (const [msgId, msg] of Object.entries(messages)) {
          if (msg.thread_fbid !== thread.id && msg.thread_fbid !== threadRelayId) continue;
          if (msg.sender_fbid === threadKey) {
            hasReply = true;
            break;
          }
        }

        if (hasSeen || hasReply) {
          results.push({
            username: otherUsername,
            hasSeen: hasSeen,
            hasReply: hasReply,
            seenAt: otherPersonSeenAt
          });
        }
      } catch (e) {}
    }

    return results;
  }
})();
