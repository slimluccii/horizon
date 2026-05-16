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
    private(set) var isConnected: Bool = false
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
        isConnected = true
        listen()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
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
                self.isConnected = false
                // Single retry with 1s backoff. More than that = user rage.
                if self.reconnectAttempts < 1, let url = self.task?.originalRequest?.url {
                    self.reconnectAttempts += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                        self?.connect(wsPath: url.path)
                    }
                }
            case .success:
                // We only send — server messages (session-ready, track-changed,
                // etc.) are not consumed by the Mac app yet. Keep looping.
                self.listen()
            }
        }
    }
}
