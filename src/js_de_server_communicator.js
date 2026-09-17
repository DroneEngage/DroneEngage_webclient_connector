import { WebSocket } from 'ws';

import * as js_andruavMessages from './shared/js_andruavMessages.js';
import {
    fn_buildAuthUrl,
    fn_buildHealthBaseUrl,
    fn_buildLoginPayload,
    fn_parseLoginResponse,
} from './shared/andruav_auth_shared.js';

import {
    fn_redactUrlSecrets,
    fn_fetchLogged,
    fn_readJsonOrText,
    fn_stripTrailingSlash,
} from './js_helpers.js';

// -----------------------------------------------------------------------------
// CDeServerCommunicator
// - Handles upstream cloud authentication and WebSocket lifecycle.
// - Maintains a single WS connection to the cloud comm server.
// - Broadcasts upstream frames via an onUpstreamMessage callback.
// - Reconnects automatically on close.
// -----------------------------------------------------------------------------
class CDeServerCommunicator {

    #cfg;
    #state;
    #onUpstreamMessage;
    #onMavlinkMessage;
    #ensureReadyPromise;
    #connectWsPromise;
    #retryTimer;
    #retryCount;

    constructor(cfg, state) {
        this.#cfg = cfg;
        this.#state = state;
        this.#onUpstreamMessage = null;
        this.#onMavlinkMessage = null;
        this.#ensureReadyPromise = null;
        this.#connectWsPromise = null;
        this.#retryTimer = null;
        this.#retryCount = 0;
    }

    /**
     * Register a callback invoked for every upstream WS frame.
     * @param {function} callback - fn(data)
     */
    setOnUpstreamMessage(callback) {
        this.#onUpstreamMessage = callback;
    }

    /**
     * Register a callback invoked for every extracted raw MAVLink payload.
     * @param {function} callback - fn(mavlinkArrayBuffer)
     */
    setOnMavlinkMessage(callback) {
        this.#onMavlinkMessage = callback;
    }

    /**
     * Extract raw MAVLink payload from an Andruav binary frame.
     * Andruav binary frame format: [JSON header string][0x00][binary payload]
     * When the JSON header's mt === CONST_TYPE_AndruavBinaryMessage_Mavlink (6502),
     * the binary payload after the null terminator is raw MAVLink.
     * @param {ArrayBuffer} buffer
     * @returns {ArrayBuffer|null} raw MAVLink payload, or null if not a MAVLink frame
     */
    #fn_extractMavlink(buffer) {
        try {
            const data = new Uint8Array(buffer);
            const nullIdx = data.indexOf(0);
            if (nullIdx <= 0) return null;

            const headerStr = new TextDecoder().decode(data.subarray(0, nullIdx));
            const header = JSON.parse(headerStr);
            if (header.mt === js_andruavMessages.CONST_TYPE_AndruavBinaryMessage_Mavlink) {
                return buffer.slice(nullIdx + 1);
            }
        } catch {
            // Not a valid Andruav binary frame or not MAVLink — silently skip
        }
        return null;
    }

    get isWsConnected() {
        return this.#state.upstream.wsConnected === true;
    }

    get hasSession() {
        return !!this.#state.upstream.auth.sessionId;
    }

    /**
     * Send data upstream to the cloud comm server.
     * @param {*} data
     * @param {{ binary: boolean }} opts
     */
    sendUpstream(data, opts) {
        if (this.#state.upstream.ws && this.#state.upstream.wsConnected === true) {
            this.#state.upstream.ws.send(data, opts);
        }
    }

    // -------------------------------------------------------------------------
    // Upstream cloud login
    // - Performs a health probe, then tries multiple login URL candidates.
    // - Stores comm server connection details for subsequent WS connection.
    // -------------------------------------------------------------------------
    async login() {
        const cfg = this.#cfg;
        const state = this.#state;

        const email = cfg.credentials?.email;
        const accessCode = cfg.credentials?.accessCode;
        const group = cfg.credentials?.group || '1';

        if (!email || !accessCode) {
            throw new Error('Missing credentials.email / credentials.accessCode in webplugin/config.json');
        }

        const host = cfg.cloud?.authHost;
        const port = cfg.cloud?.authPort;
        const secure = cfg.cloud?.authSecure === true;

        if (!host || !port) {
            throw new Error('Missing cloud.authHost / cloud.authPort in webplugin/config.json');
        }

        const loginUrl = fn_buildAuthUrl(secure, host, port, js_andruavMessages.CONST_WEB_LOGIN_COMMAND);
        const healthBaseUrl = fn_buildHealthBaseUrl(secure, host, port);

        const healthUrl = `${healthBaseUrl}/health`;

        try {
            console.info('[webplugin] cloud probe', {
                healthUrl: healthUrl,
                authHost: cfg.cloud?.authHost,
                authPort: cfg.cloud?.authPort,
                authSecure: cfg.cloud?.authSecure === true,
                wsSecure: cfg.cloud?.wsSecure === true,
            });
        } catch {
        }

        let healthRes;
        try {
            healthRes = await fn_fetchLogged(healthUrl, { method: 'GET' }, 'cloud.health');
        } catch (e) {
            const errorCode = e?.code || e?.cause?.code;
            const isNetworkError = errorCode && (errorCode === 'EAI_AGAIN' || errorCode === 'ENOTFOUND' || errorCode === 'ETIMEDOUT' || errorCode === 'ECONNREFUSED');
            const isFetchError = e?.message?.includes('fetch failed') || e?.cause?.message?.includes('fetch failed');
            
            if (isNetworkError || isFetchError) {
                console.error('[webplugin] Cloud connection failed - network error:', errorCode || 'fetch failed');
                console.error('[webplugin] Continuing in offline mode (local servers will still work)');
                throw new Error(`Cloud unreachable (${errorCode || 'network'}): ${e?.message || e?.cause?.message || 'Network error'}`);
            }
            throw e;
        }
        if (!healthRes.ok) {
            throw new Error(`Cloud health failed: ${healthRes.status}`);
        }

        const payload = fn_buildLoginPayload(email, accessCode, 'de:1.0.0', group);

        let res;
        try {
            console.info('[webplugin] cloud login request', {
                url: loginUrl,
                group: group,
            });
        } catch {
        }

        const candidates = [
            { url: loginUrl, payload: payload, tag: 'cloud.login' },
            { url: fn_stripTrailingSlash(loginUrl), payload: payload, tag: 'cloud.login.1' },
        ];

        try {
            console.info('[webplugin] cloud login candidates (in order)', candidates.map(c => ({
                tag: c.tag,
                url: fn_redactUrlSecrets(c.url),
            })));
        } catch {
        }

        res = null;
        for (let i = 0; i < candidates.length; ++i) {
            const c = candidates[i];
            const r = await fn_fetchLogged(c.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': '*/*',
                    'User-Agent': 'DroneEngage-WebPlugin/0.1.0',
                },
                body: JSON.stringify(c.payload),
            }, c.tag);

            res = r;
            if (r.status !== 404) {
                break;
            }

            try {
                console.warn('[webplugin] cloud login 404 - trying next candidate', {
                    tag: c.tag,
                    url: fn_redactUrlSecrets(c.url),
                    isRouterFallback: String(c.tag).includes('.router.') === true,
                });
            } catch {
            }
        }

        const parsedBody = await fn_readJsonOrText(res);
        if (parsedBody.json === null) {
            const snippet = (parsedBody.text || '').substring(0, 250);
            throw new Error(`Cloud login bad response (status=${res.status}) non-JSON: ${snippet}`);
        }

        const parsed = fn_parseLoginResponse(parsedBody.json);
        if (parsed.ok !== true) {
            try {
                console.error('[webplugin] cloud login failed', {
                    status: res.status,
                    e: parsed.error,
                    em: parsed.errorMessage,
                });
            } catch {
            }
            const err = new Error(`Cloud login failed: ${parsed.errorMessage || parsed.error}`);
            // Account-level rejections are not transient — retrying only
            // trips the auth server's /w/wl/ rate limiter.
            const c_permanentErrors = [
                js_andruavMessages.CONST_ERROR_ACCOUNT_NOT_FOUND,
                js_andruavMessages.CONST_ERROR_NO_PERMISSION,
                js_andruavMessages.CONST_ERROR_ACCOUNT_DISABLED,
            ];
            err.isAuthRejected = c_permanentErrors.indexOf(parsed.error) !== -1;
            throw err;
        }

        state.upstream.auth.sessionId = parsed.sessionId;
        state.upstream.auth.commServerHost = parsed.commServerHost;
        state.upstream.auth.commServerPort = parsed.commServerPort;
        state.upstream.auth.commServerAuthKey = parsed.commServerAuthKey;
        state.upstream.auth.permission = parsed.permission;
        state.upstream.auth.permission2 = parsed.permission2;
        state.upstream.auth.teamId = parsed.teamId;
        state.upstream.auth.isAdmin = parsed.isAdmin;

        try {
            console.info('[webplugin] cloud login OK', {
                commServerHost: parsed.commServerHost,
                commServerPort: parsed.commServerPort,
            });
        } catch {
        }
    }

    // -------------------------------------------------------------------------
    // Upstream cloud WebSocket
    // - Maintains a single WS connection to the cloud comm server.
    // - Broadcasts upstream frames to all local plugin clients.
    // - Reconnects automatically on close.
    // - Uses promise deduplication to prevent race conditions.
    //
    // Security item 2.1: credentials are sent as a de_auth frame (the first WS
    // message), not in the URL query string. The comm server rejects
    // query-string credentials when ws_auth_no_frame_old_compatibility=false.
    // The cs.f temp key is single-use — consumed on accept — so on any drop the
    // session is discarded and ensureReady() performs a fresh cloud login.
    // -------------------------------------------------------------------------
    connectWs() {
        const cfg = this.#cfg;
        const state = this.#state;

        // If already connecting or connected, return existing promise
        if (state.upstream.wsConnected === true || state.upstream.wsConnecting === true) {
            return this.#connectWsPromise || Promise.resolve();
        }

        // If connection attempt already in progress, wait for it
        if (this.#connectWsPromise) {
            return this.#connectWsPromise;
        }

        const host = state.upstream.auth.commServerHost;
        const port = state.upstream.auth.commServerPort;
        const authKey = state.upstream.auth.commServerAuthKey;

        if (!host || !port || !authKey) {
            throw new Error('Upstream comm server not ready (missing cs.g/cs.h/cs.f)');
        }

        const protocol = cfg.cloud?.wsSecure === true ? 'wss' : 'ws';
        const url = `${protocol}://${host}:${port}`;

        try {
            const safeUrl = fn_redactUrlSecrets(url);
            console.info('[webplugin] upstream ws connecting', { url: safeUrl });
        } catch {
        }

        state.upstream.wsConnecting = true;

        // Create promise for this connection attempt
        this.#connectWsPromise = new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            let settled = false;
            let authTimer = null;

            const fail = (err) => {
                if (settled === true) return;
                settled = true;
                if (authTimer) clearTimeout(authTimer);
                state.upstream.wsConnecting = false;
                this.#connectWsPromise = null;
                try {
                    ws.close();
                } catch {
                }
                reject(err);
            };

            // Comm server gives us 8s to deliver the de_auth frame; allow a
            // little extra for the ack to come back.
            authTimer = setTimeout(() => {
                fail(new Error('Upstream auth timeout (no de_auth_ack)'));
            }, cfg.reconnect?.upstreamAuthTimeoutMs || 10000);

            ws.onopen = () => {
                try {
                    ws.send(JSON.stringify({
                        ty: 's',
                        mt: 'de_auth',
                        f: authKey,
                        s: state.upstream.partyId,
                        at: 'g',
                    }));
                } catch (e) {
                    fail(new Error('Failed to send de_auth frame'));
                }
            };

            ws.onmessage = (evt) => {
                // Intercept the connector's own auth handshake. Other frames
                // (e.g. ConnectedCommServer, which the server sends BEFORE the
                // ack) still flow through to local clients.
                if (state.upstream.wsConnected !== true && typeof evt.data === 'string') {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(evt.data);
                    } catch {
                    }
                    if (parsed && parsed.ty === 's' && parsed.mt === 'de_auth_ack') {
                        if (parsed.r === 'ok') {
                            settled = true;
                            if (authTimer) clearTimeout(authTimer);
                            state.upstream.ws = ws;
                            state.upstream.wsConnected = true;
                            state.upstream.wsConnecting = false;

                            try {
                                console.info('[webplugin] upstream ws open');
                            } catch {
                            }
                            resolve();
                        } else {
                            fail(new Error(`Upstream auth rejected: ${parsed.em || 'de_auth_ack fail'}`));
                        }
                        return;
                    }
                }

                // Relay upstream frames to all connected local clients.
                if (this.#onUpstreamMessage) {
                    this.#onUpstreamMessage(evt.data);
                }

                // Extract raw MAVLink from Andruav binary frames and forward to MAVLink hub clients.
                if (evt.data instanceof ArrayBuffer && this.#onMavlinkMessage) {
                    const mavlinkPayload = this.#fn_extractMavlink(evt.data);
                    if (mavlinkPayload) {
                        this.#onMavlinkMessage(mavlinkPayload);
                    }
                }
            };

            ws.onerror = (err) => {
                try {
                    console.error('[webplugin] upstream ws error - will retry');
                } catch {
                }
                fail(new Error('WebSocket connection failed - will retry'));
            };

            ws.onclose = () => {
                state.upstream.wsConnected = false;
                state.upstream.wsConnecting = false;
                state.upstream.ws = null;
                this.#connectWsPromise = null;

                try {
                    console.warn('[webplugin] upstream ws close');
                } catch {
                }

                // The comm-server temp key (cs.f) is single-use — consumed on
                // accept. Drop the session so the next ensureReady() performs
                // a fresh cloud login and obtains a new key.
                state.upstream.auth.sessionId = null;
                state.upstream.auth.commServerAuthKey = null;

                fail(new Error('WebSocket closed before auth completed'));

                const delay = cfg.reconnect?.upstreamWsDelayMs || 2000;
                if (state.upstream.reconnectTimer) clearTimeout(state.upstream.reconnectTimer);
                state.upstream.reconnectTimer = setTimeout(() => {
                    try {
                        this.ensureReady().catch(() => { });
                    } catch {
                    }
                }, delay);
            };
        });

        return this.#connectWsPromise;
    }

    // Ensures the plugin has a valid cloud session and an active upstream WS.
    // Uses a shared promise to prevent race conditions when multiple clients connect simultaneously.
    async ensureReady() {
        const cfg = this.#cfg;

        if (cfg.cloud && cfg.cloud.localOnlyMode === true) {
            try {
                console.warn('[webplugin] localOnlyMode enabled - skipping upstream cloud connection');
            } catch {
            }
            return;
        }

        // If already ensuring ready, wait for the existing promise
        if (this.#ensureReadyPromise) {
            try {
                return await this.#ensureReadyPromise;
            } catch {
                // If the previous attempt failed, clear and retry
                this.#ensureReadyPromise = null;
            }
        }

        // Create new promise for this attempt
        this.#ensureReadyPromise = (async () => {
            try {
                console.info('[webplugin] ensure upstream ready', {
                    hasSession: this.hasSession,
                    wsConnected: this.isWsConnected,
                });

                if (!this.hasSession) {
                    await this.login();
                }

                if (!this.isWsConnected) {
                    await this.connectWs();
                }

                this.#retryCount = 0;
            } catch (e) {
                // On network errors or "No available Server" errors, schedule a retry
                const isNetworkError = e?.isNetworkError === true || 
                                      e?.code === 'ENETWORK' ||
                                      e?.message?.includes('Cloud unreachable');
                const isNoServerError = e?.message?.includes('No available Server') ||
                                       e?.message?.includes('Cloud login failed');
                // Account-level rejections (bad credentials, no permission,
                // disabled account) are permanent — retrying them only trips
                // the auth server's login rate limiter.
                const isAuthRejected = e?.isAuthRejected === true;
                
                if (isAuthRejected) {
                    console.error('[webplugin] Upstream auth rejected - check credentials in config.json. Not retrying.');
                } else if (isNetworkError || isNoServerError) {
                    const baseDelay = cfg.reconnect?.upstreamWsDelayMs || 2000;
                    // Exponential backoff capped at 120s so retries stay well
                    // under the auth server's 10-requests/minute rate limit.
                    const retryDelay = Math.min(baseDelay * Math.pow(2, this.#retryCount), 120000);
                    this.#retryCount += 1;
                    console.info(`[webplugin] Scheduling upstream retry in ${retryDelay}ms (attempt ${this.#retryCount})`);
                    
                    if (this.#retryTimer) {
                        clearTimeout(this.#retryTimer);
                    }
                    
                    this.#retryTimer = setTimeout(async () => {
                        try {
                            console.info('[webplugin] Retrying upstream connection...');
                            await this.ensureReady();
                        } catch {
                            // Retry failed, will schedule another retry
                        }
                    }, retryDelay);
                }
                throw e;
            } finally {
                // Clear promise after completion (success or failure)
                this.#ensureReadyPromise = null;
            }
        })();

        return await this.#ensureReadyPromise;
    }
}

export default CDeServerCommunicator;
