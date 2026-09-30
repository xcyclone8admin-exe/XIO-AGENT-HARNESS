# Architecture

The canonical architecture lives in the project control plane (not in this repository):
`projects/institutional-agent-os/architecture/ARCHITECTURE.md` and `architecture/decisions/ADR-*.md`.

This repository follows it: `apps/*` (web, sidecar, cloud, desktop), `packages/*` (shared horizontal
libraries), `modules/<id>/` (one XIO pillar surface each; see ADR-0006 for the plug-in contract).
