# System Design Drafts

This repository stores system design drafts. Each project lives in `designs/<project-slug>/`.

## Layout

```
designs/<project-slug>/
  README.md                 # index: project summary + story list
  00-overview.md            # system design overview
  01-architecture.md        # solution architecture + Mermaid diagram
  stories/NN-<slug>.md      # one document per user story
  api/
    stories/NN-<slug>.md    # API design derived from each story
    applications/<app-slug>.md  # API design aggregated per application
```

## Conventions

- Diagrams use Mermaid code blocks (`flowchart`, `sequenceDiagram`). After editing any diagram, validate it: `npm install` once, then `npm run validate:diagrams` — parses every ```` ```mermaid ```` block in `designs/` and `templates/` with Mermaid's own parser and exits non-zero on broken diagrams.
- Story documents and API documents use the templates in `templates/`.
- Numbering: `NN` is a zero-padded story counter, e.g. `01-checkout.md`.
- Every endpoint has a single authoritative definition in `api/applications/<app-slug>.md`; per-story API docs (`api/stories/`) reference it by anchor instead of duplicating schemas.
- Per-story API docs contain only the interaction flow: sequence diagram, ordered calls (sync/async), data passed between steps, and failure/consistency behavior.
- The `api/stories/` (per story) and `api/applications/` (per application) documents must stay consistent; update both when interactions change.
- Each per-application API document lists **Resources handled** (resources it owns/exposes) and **Resources used** (resources owned by other applications it consumes, with owner and interface).
