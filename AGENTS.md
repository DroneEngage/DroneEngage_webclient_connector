# AGENTS.md — droneengage_webclient_connector

Node.js local WebSocket hub for DroneEngage WebClients: keeps **one**
upstream connection to the Andruav cloud comm server and shares it
across multiple local WebClient instances. Also runs a MAVLink hub
(port 8811) that extracts raw MAVLink frames from Andruav binary
messages so tools like Mavlink3DMap2 can consume telemetry without a
separate bridge. See `../AGENTS.md` for the workspace conventions.

## Run

    npm install
    ./start.sh                    # or: node src/index.js  (start.bat on Windows)

If the WebClient is served over HTTPS, put a TLS terminator in front
(Caddy — `src/cli_caddy.js`, `Caddyfile.localplugin`) to avoid browser
mixed-content blocking; see `README_CADDY.md` / `DEPLOYMENT.md`.
`run_local_plugin_stack.sh` starts the whole local stack.

## Layout

`src/index.js` (entry), `js_local_server.js` (client-facing ws),
`js_de_server_communicator.js` (upstream cloud link), `cli_stack.js`,
`shared/`, `scripts/`, `auth_sample_example.js`, `config.json`,
`wiki/`. `DEPLOYMENT.md` — cross-platform install; `SETUP_BROWSER.md` —
browser side.
