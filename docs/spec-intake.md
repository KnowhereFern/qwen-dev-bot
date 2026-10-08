# Start with an idea or document

Fern can draft a product specification before a folder has Git, GitHub or harness configuration. The model writes the specification; an operator does not need to prepare a requirements document first.

In the interactive console, choose **9 · Draft spec from idea/document**. Select a document or describe your idea. PDF page ranges let you exclude unrelated or sensitive pages before sending input to your configured provider.

Type a menu number, then press Enter. If a draft already exists, **3 · Review a saved specification** is selected by default. In document/idea input, **0** followed by Enter (or an empty Enter) returns to the spec menu without generating anything.

```sh
fern-harness spec /path/to/project --input idea.pdf --pages 1-8
fern-harness spec /path/to/project --idea 'Build a tool that ...'
fern-harness spec-status /path/to/project --spec spec_ID
```

Intake supports text-based PDF, Markdown and UTF-8 text. It does not interpret diagrams, perform OCR or follow links/embedded instructions. Unread visual content is explicitly recorded as unverified, not silently treated as understood. Empty/scanned PDFs require a text/OCR version. Limits: 20 MB file, 200 PDF pages, 200 KB extracted text.

The draft includes the objective, users, source-grounded requirements, acceptance criteria, assumptions, product decisions with recommendations, non-goals and unproven claims needing validation. Source quotes are checked against the supplied sections. Quote matching proves the quotation exists, not that the model's interpretation or coverage is correct: review the proposal before approving a delivery program.

## Privacy and authority

- Only the selected input goes to the existing configured model provider. No tools, linked files, web requests or implementation sessions are given to the drafting model.
- Existing project model configuration takes precedence. Before setup, the exact saved Qwen model/endpoint pair selects its credential variable; duplicate model IDs cannot silently switch billing routes.
- Full source documents are not copied into the repository or published. Private draft records live under the harness state directory's `intake/` folder with owner-only permissions. Records retain source hashes, selected section references, source quotations and model provenance, not the raw extracted document.
- Input may contain private information that pattern redaction cannot recognize. Select appropriate pages before sending it; do not assume automatic redaction removes all personal data.
- Repeating the exact same input and connection reuses its draft. Changed input produces a new draft; previous records remain intact.
- Validation corrections are limited to three attempts within a ten-minute overall generation deadline. Cancellation or an invalid response never becomes a saved successful specification.
- Intake never initializes Git, creates GitHub issues, approves work, installs a worker, or deploys. The target folder is not modified.

## Continue into delivery

Review the draft and resolve consequential product decisions. Then configure the repository through normal project setup. The plan command can consume the saved spec directly—no hand-authored requirements file or copied PDF is necessary:

For a new repository, the draft can propose the stack and scaffolding before product tests exist. Configure required product-check commands for that proposed stack before approving the program. The harness creates their implementation in its first delivery work; an empty or security-only gate list cannot authorize a new program. A passing setup workflow alone is not product verification.

```sh
fern-harness plan /path/to/project --spec spec_ID
```

This next command uses the existing GitHub planning workflow and can publish proposal issues to the configured repository. Verify its visibility and that the generated spec is appropriate to publish first. Do not publish confidential source documents. Program approval remains a separate action; drafting a spec does not authorize execution.

PDF extraction uses Mozilla's [PDF.js Node API](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs), with document evaluation disabled.
