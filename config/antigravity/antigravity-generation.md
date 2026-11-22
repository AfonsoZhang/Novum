# Built-in image generation on Antigravity (Nano Banana)

When `provider` is `antigravity`, or the user asks for Antigravity or Nano Banana,
Antigravity is already the active host and generates the image natively via its
built-in `image-generator` subagent. Do not call an external
`mcp__antigravity__antigravity` server.

## Call

- Invoke `invoke_subagent` with `TypeName: "image-generator"`, a concise `Role`
  (e.g., `"Scientific Figure Generator"`), and a `Prompt` containing the figure
  brief, English labels unless requested otherwise, explicit edit/reference image
  paths and roles, and the requested output format/destination.
- Wait reactively for the subagent's reply with the saved image path(s). If the
  subagent is unavailable or fails, preserve the prompt and references and report
  `IMAGE_UNAVAILABLE`; do not silently fall back to a paid API or a code-drawn
  placeholder.

## Inspect and deliver

1. Open the generated image with `read_file` to inspect scientific meaning, text
   labels, dimensions and visual quality. Apply the same figure QA as the
   `imagegen` route.
2. Copy the accepted image from the returned path into the project destination
   (converting JPEG to PNG if PNG is required), preserving existing versions
   unless replacement was requested.
3. Record the prompt, reference paths, subagent conversation ID and only exposed
   model/tool metadata (`Antigravity image-generator`). Generated images are for
   illustration and exploration, never evidence figures.
