# Interactive terminal validation

The interactive console has four shared surfaces: keyboard menus, read-only readers, wrapped output, and labeled input/confirmation prompts. The normal scriptable CLI and JSON output deliberately remain unchanged. GitHub's external sign-in command keeps GitHub CLI's own interface.

## Coverage

| Flow | Checks |
| --- | --- |
| Project selection and setup | Existing/new folder selection; setup, asset refresh and sign-in cancellation; same action heading and prompt presentation |
| Plan creation and revision | File prompts, invalid values, cancellation and frozen-objective guards |
| Plan review | All ten sections and full plan reachable; no omitted contracts; separate approval action and exact typed revision/hash guards |
| Model connection | All provider routes; private input; cancellation; explicit live verification; no keys in output |
| Delivery | Worker-status read; blocked unapproved work; separately confirmed start/cycle; shared-worker warning preserved |
| Evidence | Deployment, feedback, logs, evidence report and controller history routes |
| Progress | Read-only live reader; refresh errors; no overlapping polls; cleanup on exit |
| Results and errors | Wrapped shared typography; failed commands return to the console; long recent output opens a reader |
| Keyboard/layout | Arrows, Enter, shortcuts, Esc, Ctrl-C/D, EOF, resize, Unicode, no color, reduced motion, short/narrow viewports |

Navigation and mutation branches are exercised with injected command/credential handlers. These are UI tests, not proof of provider integrations or autonomous product delivery. Live smoke checks use read-only views; UI validation must not approve a real plan, save a real credential or start execution.

The recent-result reader keeps up to 200,000 characters and marks omitted earlier output, which remains in terminal scrollback. The plan reader is not subject to this transcript limit. Provider failures are simulated in tests; no claim is made to enumerate every operating-system or external-service failure.

Run `npm run typecheck`, `npm test`, `npm run release:check`, and `npm run package:smoke`. Manually check a real terminal through home → plan selection → review sections → reader → back, and home → model connection → provider choice → cancel. Verify the cursor and shell input recover after Ctrl-C.
