import SwiftUI

/// Show detail — cinematic backdrop + left poster + title/overview on the
/// right + season pills + rich episode rows.
struct ShowDetailView: View {
    let showId: String

    @Environment(HorizonClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var show: ShowSummary?
    @State private var season: Int?
    @State private var episodes: [MediaItem] = []
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                heroSection
                body_
            }
        }
        .scrollIndicators(.hidden)
        .background(Color.horizonBg.ignoresSafeArea())
        .overlay(alignment: .top) {
            LargeTopNav(active: .series, transparent: true, onBack: { dismiss() })
        }
        .task { await load() }
        // React to user-initiated season changes (pill taps). The initial
        // season is loaded by load(); this handles every selection after that.
        .onChange(of: season) { _, newSeason in
            guard let newSeason else { return }
            Task { await loadEpisodes(for: newSeason) }
        }
        .navigationBarBackButtonHidden()
    }

    // MARK: - Hero

    @ViewBuilder
    private var heroSection: some View {
        if let show {
            ZStack(alignment: .bottomLeading) {
                // Backdrop
                if let url = TmdbImage.url(show.metadata?.backdropPath, size: .w780) {
                    AsyncImage(url: url) { phase in
                        if case .success(let img) = phase {
                            img.resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Color.horizonSurface
                        }
                    }
                    .frame(height: 560)
                    .clipped()
                } else {
                    Color.horizonSurface2.frame(height: 560)
                }

                // Scrim
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.9), location: 0),
                        .init(color: .black.opacity(0.5), location: 0.55),
                        .init(color: .black.opacity(0.3), location: 1)
                    ],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(height: 560)

                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .clear, location: 0.7),
                        .init(color: Color.horizonBg, location: 1)
                    ],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: 560)

                HStack(alignment: .bottom, spacing: 48) {
                    if let url = TmdbImage.url(show.metadata?.posterPath, size: .w342) {
                        AsyncImage(url: url) { phase in
                            if case .success(let img) = phase {
                                img.resizable().aspectRatio(contentMode: .fill)
                            } else {
                                Color.horizonSurface
                            }
                        }
                        .frame(width: 240, height: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .shadow(color: .black.opacity(0.7), radius: 40, y: 30)
                    }
                    heroText
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 64)
                .padding(.top, 120)
                .padding(.bottom, 72)
            }
            .frame(height: 560)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var heroText: some View {
        if let show {
            VStack(alignment: .leading, spacing: 16) {
                Text("Series").eyebrow()
                Text(show.metadata?.title ?? show.title)
                    .font(.horizon(size: 48, weight: .heavy))
                    .kerning(-1.44)
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 16, y: 4)

                if let tagline = show.metadata?.tagline {
                    Text(tagline)
                        .font(.horizon(size: 16, weight: .regular).italic())
                        .foregroundStyle(.horizonMutedHi)
                }

                HStack(spacing: 10) {
                    if let y = show.metadata?.firstAirDate?.prefix(4) {
                        Text(String(y))
                    }
                    bullet
                    Text("\(show.seasons.count) season\(show.seasons.count == 1 ? "" : "s")")
                    bullet
                    Text("\(totalEpisodes) episode\(totalEpisodes == 1 ? "" : "s")")
                    if let status = show.metadata?.status { bullet; Text(status) }
                    if let net = show.metadata?.network { bullet; Text(net) }
                    if let rating = show.metadata?.rating {
                        bullet
                        Text(String(format: "★ %.1f", rating))
                            .foregroundStyle(.horizonImdb)
                    }
                }
                .font(.horizon(size: 13, weight: .regular))
                .foregroundStyle(.horizonMutedHi)

                if let overview = show.metadata?.overview {
                    Text(overview)
                        .font(.horizon(size: 15, weight: .regular))
                        .foregroundStyle(Color.horizonTextSoft)
                        .lineLimit(4)
                        .frame(maxWidth: 640, alignment: .leading)
                }
            }
        }
    }

    private var bullet: some View {
        Text("·").foregroundStyle(Color(white: 0.25))
    }

    private var totalEpisodes: Int {
        show?.seasons.reduce(0) { $0 + $1.episodeCount } ?? 0
    }

    // MARK: - Body

    @ViewBuilder
    private var body_: some View {
        if let show {
            VStack(alignment: .leading, spacing: 28) {
                // Season pills
                HStack(spacing: 10) {
                    ForEach(show.seasons, id: \.number) { s in
                        Button {
                            season = s.number
                        } label: {
                            HStack(spacing: 6) {
                                Text("Season \(s.number)")
                                Text("· \(s.episodeCount)")
                                    .foregroundStyle(Color.white.opacity(0.7))
                            }
                            .font(.horizon(size: 13, weight: season == s.number ? .bold : .semibold))
                            .foregroundStyle(season == s.number ? Color.horizonAccent : .white)
                            .padding(.horizontal, 16)
                            .frame(height: 36)
                            .background(
                                Capsule().fill(season == s.number ? Color.horizonAccentDim : Color.white.opacity(0.06))
                            )
                            .overlay(
                                Capsule().strokeBorder(
                                    season == s.number ? Color.horizonAccent.opacity(0.4) : Color.horizonBorder
                                )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                // Episode list
                VStack(spacing: 14) {
                    ForEach(episodes) { ep in
                        NavigationLink(value: Route.play(ep.id)) {
                            EpisodeRow(episode: ep)
                        }
                        .buttonStyle(.plain)
                    }
                    if episodes.isEmpty {
                        Text("No episodes in this season.")
                            .font(.horizon(size: 14, weight: .regular))
                            .foregroundStyle(.horizonMutedHi)
                    }
                }
            }
            .padding(.horizontal, 48)
            .padding(.vertical, 24)
        }
    }

    // MARK: - Load

    private func load() async {
        do {
            let s = try await client.api.getShow(showId)
            await MainActor.run {
                self.show = s
                self.season = s.seasons.first?.number
            }
            if let season = s.seasons.first?.number {
                await loadEpisodes(for: season)
            }
        } catch {
            await MainActor.run { self.error = error.localizedDescription }
        }
    }

    /// Fetch episodes for `season` and publish them only if the user hasn't
    /// since selected a different season. The guard against `self.season`
    /// discards stale responses, so rapidly tapping season pills always ends
    /// on the most recently selected season's episodes rather than whichever
    /// request happens to finish last.
    private func loadEpisodes(for season: Int) async {
        do {
            let eps = try await client.api.listEpisodes(showId: showId, season: season)
            await MainActor.run {
                // Only apply if this is still the selected season.
                guard self.season == season else { return }
                self.episodes = eps
                self.error = nil
            }
        } catch {
            await MainActor.run {
                guard self.season == season else { return }
                self.error = error.localizedDescription
            }
        }
    }
}

/// Per-episode row on the show detail page. 16:9 still + metadata +
/// clamped overview + play badge on hover.
struct EpisodeRow: View {
    let episode: MediaItem

    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.horizonSurface)
                if let url = TmdbImage.url(episode.metadata?.stillPath, size: .w342) {
                    AsyncImage(url: url) { phase in
                        if case .success(let img) = phase {
                            img.resizable().aspectRatio(contentMode: .fill)
                        }
                    }
                }

                ZStack {
                    Circle().fill(Color.white.opacity(0.92))
                    Image(systemName: "play.fill")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.black)
                }
                .frame(width: 32, height: 32)
                .padding(10)
                .opacity(hovering ? 1 : 0)
                .offset(y: hovering ? 0 : 6)
                .animation(.easeOut(duration: 0.12), value: hovering)
            }
            .frame(width: 240, height: 135)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    if let n = episode.episode {
                        Text(String(format: "E%02d", n))
                            .font(.horizon(size: 12, weight: .heavy))
                            .kerning(1.2)
                            .textCase(.uppercase)
                            .foregroundStyle(.horizonAccent)
                    }
                    Text(episode.title)
                        .font(.horizon(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }

                HStack(spacing: 10) {
                    Text("\(Int(episode.duration / 60))m")
                    if let res = episode.resolution, !res.isEmpty {
                        dot
                        Text(res)
                    }
                    if episode.hasDolbyVision {
                        dot
                        Text("Dolby Vision").foregroundStyle(Color(red: 167/255, green: 139/255, blue: 250/255)).bold()
                    }
                    if let codec = episode.audioTracks?.first?.codec {
                        dot
                        Text(codec.uppercased())
                    }
                    if let air = episode.metadata?.airDate {
                        dot; Text(air)
                    }
                }
                .font(.horizon(size: 12, weight: .regular))
                .foregroundStyle(.horizonMutedHi)

                if let overview = episode.metadata?.overview {
                    Text(overview)
                        .font(.horizon(size: 13, weight: .regular))
                        .foregroundStyle(.horizonMutedHi)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 8)
            .padding(.trailing, 12)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(hovering ? 0.05 : 0.02))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(hovering ? Color.horizonBorderHi : Color.horizonBorder)
        )
        .offset(y: hovering ? -2 : 0)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: hovering)
        .onHover { hovering = $0 }
    }

    private var dot: some View {
        Text("·").foregroundStyle(Color(white: 0.25))
    }
}
