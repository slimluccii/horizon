import SwiftUI
import AVKit

/// Native HLS player. Our server transcodes to h264 + AAC so AVPlayer decodes
/// everything on VideoToolbox hardware — no third-party player required.
/// Flow:
///   1. Fetch saved progress (if any). If > 5s and !watched, show resume toast.
///   2. User decides → POST /sessions with `startPositionMs`.
///   3. Build AVPlayer with the m3u8 URL, start playback.
///   4. Connect WS, pump `reportProgress` every 5s during playback.
///   5. On dismiss, call DELETE /sessions/:id to tear down the ffmpeg process.
struct PlayerView: View {
    let mediaId: String

    @Environment(HorizonClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var decision: Decision = .pending
    @State private var resumeMs: Int = 0
    @State private var durationMs: Int = 0
    @State private var session: SessionInfo?
    @State private var player: AVPlayer?
    @State private var socket = ProgressSocket()
    @State private var timeObserver: Any?
    @State private var error: String?
    @State private var startedAt: Date = .now

    enum Decision { case pending, resume, startOver, ready }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Video
            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
                    .onAppear { player.play() }
            }

            // Back button
            VStack {
                HStack {
                    Button(action: teardown) {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 12, weight: .heavy))
                            Text("Library")
                                .font(.horizon(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Color(red: 20/255, green: 30/255, blue: 42/255).opacity(0.85),
                                    in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.white.opacity(0.22)))
                        .background(.ultraThinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    Spacer()
                }
                .padding(20)
                Spacer()
            }

            // Resume toast
            if decision == .pending && resumeMs > 5000 {
                resumeToast
            }

            // Loading
            if player == nil && decision != .pending {
                loadingOverlay
            }

            // Error
            if let error {
                errorOverlay(error)
            }
        }
        .navigationBarBackButtonHidden()
        .task { await fetchProgress() }
        .task(id: decision) {
            if decision == .resume || decision == .startOver {
                await startSession()
            }
        }
        .onDisappear { teardown() }
    }

    // MARK: - Fetch saved progress

    private func fetchProgress() async {
        guard let userId = client.activeUser?.id else {
            decision = .startOver
            return
        }
        do {
            if let p = try await client.api.getProgress(userId: userId, mediaId: mediaId),
               p.positionMs > 5000 && !p.watched {
                await MainActor.run {
                    self.resumeMs = p.positionMs
                    self.durationMs = p.durationMs
                }
            } else {
                await MainActor.run { self.decision = .startOver }
            }
        } catch {
            await MainActor.run { self.decision = .startOver }
        }
    }

    // MARK: - Start session

    private func startSession() async {
        let startMs = (decision == .resume) ? resumeMs : nil
        do {
            let s = try await client.api.createSession(
                mediaId: mediaId,
                startPositionMs: startMs,
                userId: client.activeUser?.id
            )
            await MainActor.run {
                self.session = s
                configurePlayer(with: s)
                socket.connect(wsPath: s.wsUrl)
                self.decision = .ready
            }
        } catch {
            await MainActor.run { self.error = error.localizedDescription }
        }
    }

    // MARK: - AVPlayer

    private func configurePlayer(with session: SessionInfo) {
        let url = HorizonServer.baseURL.appendingPathComponent(session.streamUrl)
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.automaticallyWaitsToMinimizeStalling = true
        self.player = p

        // Progress reporter — every 5s while playing.
        let interval = CMTime(seconds: 5, preferredTimescale: 1)
        self.timeObserver = p.addPeriodicTimeObserver(forInterval: interval, queue: .main) { time in
            let posMs = Int(time.seconds * 1000)
            let durSec = p.currentItem?.duration.seconds ?? 0
            if durSec.isFinite && durSec > 0 {
                socket.reportProgress(positionMs: posMs, durationMs: Int(durSec * 1000))
            }
        }
    }

    private func teardown() {
        if let p = player, let t = timeObserver {
            p.removeTimeObserver(t)
        }
        timeObserver = nil
        player?.pause()
        socket.disconnect()
        if let id = session?.sessionId {
            Task { try? await client.api.destroySession(id) }
        }
        dismiss()
    }

    // MARK: - Toast / overlays

    private var resumeToast: some View {
        VStack {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Continue").eyebrow()
                    Text("Resume from \(fmt(resumeMs))?")
                        .font(.horizon(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                }
                Button("Resume") {
                    decision = .resume
                }
                .buttonStyle(.plain)
                .font(.horizon(size: 13, weight: .bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 16).frame(height: 36)
                .background(Color.horizonAccent, in: Capsule())
                .shadow(color: .horizonAccent.opacity(0.66), radius: 20, y: 8)

                Button("Start over") {
                    decision = .startOver
                }
                .buttonStyle(.plain)
                .font(.horizon(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).frame(height: 36)
                .background(Color.white.opacity(0.06), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.horizonBorder))
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .background(Color(red: 10/255, green: 22/255, blue: 34/255).opacity(0.92),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.horizonBorder)
            )
            .shadow(color: .black.opacity(0.6), radius: 24, y: 24)
            .padding(.top, 96)
            Spacer()
        }
    }

    private var loadingOverlay: some View {
        VStack(spacing: 14) {
            ProgressView().progressViewStyle(.circular).tint(.horizonAccent)
            Text("Starting playback…")
                .font(.horizon(size: 12, weight: .bold))
                .kerning(2.4)
                .textCase(.uppercase)
                .foregroundStyle(.horizonMuted)
        }
    }

    private func errorOverlay(_ message: String) -> some View {
        VStack(spacing: 16) {
            Text("Playback error")
                .font(.horizon(size: 20, weight: .heavy))
                .foregroundStyle(.horizonDanger)
            Text(message)
                .font(.horizon(size: 14, weight: .regular))
                .foregroundStyle(.horizonMutedHi)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)
            Button("Back to library") { teardown() }
                .buttonStyle(.plain)
                .font(.horizon(size: 14, weight: .bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 22).frame(height: 44)
                .background(Color.horizonAccent, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func fmt(_ ms: Int) -> String {
        let totalSec = ms / 1000
        let h = totalSec / 3600
        let m = (totalSec % 3600) / 60
        let s = totalSec % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }
}
