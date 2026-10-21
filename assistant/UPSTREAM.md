# Mintlify assistant source provenance

Upstream: https://github.com/mintlify/mintlify-astro-starter
Commit: c84e7a3a64d0637009e37e76c4cd04917ed1d1a9
License: MIT, preserved in licenses/Mintlify-MIT.txt and the distributed learning-assistant.js.LEGAL.txt.

The assistant is an adapted frontend module, not an unmodified copy of the documentation site.

- AssistantSheet.tsx retains the upstream desktop sheet/mobile portal, width toggle, scroll references and swipe-to-dismiss structure. It is controlled by the host website and uses scoped CSS.
- AssistantTextArea.tsx retains the input/ref, focus and Enter submission structure; adds IME handling, mobile behavior and stop generation.
- ChatMessage.tsx retains the user-message rendering structure; adds per-message references.
- ChatResponse.tsx adapts Markdown/GFM and copy behavior; removes Mintlify search tools and links, inline style injection, and remote image rendering.
- AssistantHistoryList.tsx adapts the message/loading list; adds turn status, retry and regeneration.
- useSwipeToDismiss.ts is copied from upstream, with form-control gesture exclusion.
- useAssistant.ts adapts the upstream useChat/DefaultChatTransport flow to our API, account/article isolation, cancellation, bounded browser history and request context.

UI helpers and all website/business integration are maintained by this project. No Mintlify account or API is used by the adapted module. React and AI SDK versions are locked in package-lock.json.
