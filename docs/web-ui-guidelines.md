# Web UI Guidelines

Rules from reviewed Web changes. `apps/web/AGENTS.md` links here. Each rule names
the component or file to reuse so a change can start from working code.

## Use the shared component, not the native element

- Dropdowns use `Select` and `SelectItem` from `src/components/ui/select.tsx`,
  never a native `<select>`. `Select` needs an `aria-label`; put the visible
  label in a sibling element, not in a wrapping `<label>`.
  Example: `src/features/apps/custom-mcp-connectors.tsx` (authentication
  method) and `src/features/library/copy-to-my-documents-dialog.tsx`.
- Text inputs in forms use the field style `fieldControlClassName` from
  `src/components/ui/field.tsx`.
- Buttons use `Button`, icons use `Icon`, dialogs use `ModalDialog`, and grouped
  rows use `SettingsGroup` / `SettingsRow` / `SettingsRowText` from
  `src/components/ui/settings-group.tsx`. Before writing raw markup for one of
  these, look in `src/components/ui`.

## Dialog spacing

- `.app-dialog-body` has no padding (`src/app/globals.css`). A dialog body must
  wrap its content in its own padded container (for example
  `space-y-3 px-5 pb-2`); otherwise fields touch the dialog edges.
- Give every dialog a one-sentence `description` that says what the feature is
  for and what happens when the user acts (for example, that each Agent call
  asks for confirmation).

## Status and lists

- Show a live status with `StatusDot` from
  `src/features/local-computer/computer-row.tsx`: `success` is the green dot,
  `warning` the yellow one. Pair it with a short text such as "Connected" and a
  count, and use `text-app-danger` for text that needs action.
- Do not render a list of discovered items (tools, files, accounts) as bare
  text lines. Use a bordered, scrollable list with a fixed maximum height
  (`max-h-48 divide-y divide-border overflow-y-auto rounded-xl border`): the
  name in `font-mono text-xs`, the description under it clamped to two lines
  (`line-clamp-2`).
- Put the status next to the list heading, not only in a toast or a log.

## Keep one entity consistent across surfaces

- When the same entity appears in more than one place (a card on the Connectors
  page, a row in the Agent panel, the edit dialog), change them together. A new
  status line, a renamed label, or a removed field must land on every surface in
  the same change. Search for the entity's message keys and component names
  before calling the change done.
- Share the wording through the feature's `*.messages.ts` file and add the
  translation to `src/i18n/locales/zh-CN.json`; do not copy strings.

## Fields

- Do not ask the user for a value the system can derive. Remove optional
  advanced inputs (such as an OAuth scope string) unless a real case needs them;
  the server picks the default.
- Do not surface a raw protocol value to the user. Show a labelled choice
  instead.

## Navigation hover

- A collapsed navigation button keeps its size on hover and focus. Its label
  floats beside it as a small tooltip with `pointer-events: none`, so the label
  never takes hover from the button.

## Checking a UI change

- Open the real screen after the change, in the Desktop app or the Web build,
  and compare it with the neighbouring screens. Type checks and unit tests do
  not catch spacing, overflow, or a missing status line.
