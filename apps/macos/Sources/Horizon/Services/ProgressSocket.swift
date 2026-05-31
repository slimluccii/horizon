import Foundation

/// Lightweight WebSocket wrapper that mirrors the web SDK's progress-reporting
/// contract: connect on session start, `reportProgress(positionMs:durationMs:)`
/// is called every 5s + on pause / seek. Server coalesces into a DB flush.
///
/// Uses URLSessionWebSocketTask — no third-party deps. Reconnects once on
/// failure; beyond that the surrounding view can observe `isConnected` and
/// surface an alert.
@Observable
final class ProgressSocket {
    /// Internal connection lifecycle. The public `isConnected` flag is derived
    /// from this so the UI never sees `true` until the socket has actually
    /// proven itself by receiving at least one message from the server.
    enum ConnectionState {
        case idle, connecting, connected, disconnected
    }

    /// Public flag the UI observes. Only `true` once `state == .connected`.
    private(set) var isConnected: Bool = false

    /// Actual connection state. Setting it keeps `isConnected` in sync so the
    /// boolean and the state machine can never diverge.
    private var state: ConnectionState = .idle {
        didSet { isConnected = (state == .connected) }
    }

    private var task: URLSessionWebSocketTask?
    private var reconnectAttempts = 0

    /// Form an absolute ws:// URL from the server origin + the path returned
    /// by POST /sessions (`/sessions/:id/ws`).
    func connect(wsPath: String) {
        disconnect()
        guard var comps = URLComponents(url: HorizonServer.baseURL, resolvingAgainstBaseURL: false)
        else { return }
        let currentScheme = comps.scheme
        comps.scheme = (currentScheme == "https") ? "wss" : "ws"
        comps.path = wsPath
        guard let url = comps.url else { return }

        let t = URLSession.shared.webSocketTask(with: url)
        self.task = t
        t.resume()
        // We're only connecting at this point — the WS handshake may still be in
        // flight. `isConnected` stays false until the first successful receive
        // confirms a live, usable connection (see listen()).
        state = .connecting
        listen()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
    }

    /// Send a progress update over the open socket. Silent no-op when
    /// disconnected — the flusher on the server keeps the last flushed value
    /// so a brief disconnect isn't fatal.
    func reportProgress(positionMs: Int, durationMs: Int) {
        guard let t = task else { return }
        struct Msg: Encodable {
            let type = "progress"
            let positionMs: Int
            let durationMs: Int
        }
        let msg = Msg(positionMs: positionMs, durationMs: durationMs)
        guard let data = try? JSONEncoder().encode(msg),
              let text = String(data: data, encoding: .utf8) else { return }
        t.send(.string(text)) { _ in /* swallow transient send errors */ }
    }

    // MARK: - Receive loop

    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.state = .disconnected
                // Single retry with 1s backoff. More than that = user rage.
                if self.reconnectAttempts < 1, let url = self.task?.originalRequest?.url {
                    self.reconnectAttempts += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                        self?.connect(wsPath: url.path)
                    }
                }
            case .success:
                // First successful receive proves the connection is live and
                // usable — only now do we flip to .connected (and isConnected).
                // The server sends `session-ready` immediately on connect, so
                // this resolves promptly. Subsequent receives leave state as-is.
                if self.state != .connected {
                    self.state = .connected
                }
                // We only send — server messages (session-ready, track-changed,
                // etc.) are not consumed by the Mac app yet. Keep looping.
                self.listen()
            }
        }
    }
}
