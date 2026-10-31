# AGENTS.md — droneengage_webclient_connector

Node.js local WebSocket hub for DroneEngage WebClients: keeps **one**
upstream connection to the Andruav cloud comm server shared across
multiple local WebClient instances, plus a MAVLink hub (port 8811) for
tools like Mavlink3DMap2.

## Quickstart

    npm install
    ./start.sh                    # or: node src/index.js  (start.bat on Windows)

## Index — `.agents/wiki/`

| File | What it covers |
|---|---|
| [`agents_overview.md`](.agents/wiki/agents_overview.md) | TLS-terminator requirement, run scripts, source layout |

See `../AGENTS.md` for the workspace conventions.
