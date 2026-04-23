import SwiftUI

/// Library landing. Cinematic hero for a featured movie, Continue Watching
/// rail, then a pillar of tabs (Movies / Series / Collections) with a 2:3
/// poster grid. Mirrors the web Library.tsx layout and palette.
struct LibraryView: View {
    @Environment(HorizonClient.self) private var client

    @State private var tab: TabKey = .movies
    @State private var movies: [MediaItem] = []
    @State private var shows: [ShowSummary] = []
    @State private var collections: [Collection] = []
    @State private var cwItems: [ContinueWatchingItem] = []
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                heroSection
                    .padding(.bottom, -40)

                VStack(alignment: .leading, spacing: 36) {
                    if !cwItems.isEmpty {
                        continueWatchingRail
                    }
                    sectionHeader
                    tabPills
                    grid
                }
                .padding(.horizontal, 48)
                .padding(.top, 24)
                .padding(.bottom, 48)
            }
        }
        .scrollIndicators(.hidden)
        .background(Color.horizonBg.ignoresSafeArea())
        .overlay(alignment: .top) {
            LargeTopNav(active: tab, transparent: heroURL != nil, onTabChange: { tab = $0 })
        }
        .task { await load() }
    }

    // MARK: - Hero

    private var heroMovie: MediaItem? {
        movies.first(where: { $0.metadata?.backdropPath != nil }) ?? movies.first
    }
    private var heroURL: URL? {
        TmdbImage.url(heroMovie?.metadata?.backdropPath, size: .w780)
    }

    @ViewBuilder
    private var heroSection: some View {
        if let hero = heroMovie, let url = heroURL {
            ZStack(alignment: .bottomLeading) {
                // Backdrop — async-loaded, fills the hero band, faded via gradients.
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Color.horizonSurface
                    }
                }
                .frame(height: 640)
                .clipped()

                // Vertical scrim — top shade for nav legibility + bottom fade to bg.
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.4), location: 0),
                        .init(color: .clear, location: 0.3),
                        .init(color: .clear, location: 0.55),
                        .init(color: Color.horizonBg.opacity(0.85), location: 0.92),
                        .init(color: Color.horizonBg, location: 1)
                    ],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: 640)

                // Horizontal scrim — darken the left ~60% for type legibility.
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.85), location: 0),
                        .init(color: .black.opacity(0.4), location: 0.4),
                        .init(color: .clear, location: 0.7)
                    ],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(height: 640)

                heroContent(hero)
                    .padding(.leading, 64)
                    .padding(.bottom, 72)
            }
            .frame(height: 640)
            .frame(maxWidth: .infinity)
        } else {
            // No hero available — reserve a small band so the nav still has room.
            Color.clear.frame(height: 96)
        }
    }

    @ViewBuilder
    private func heroContent(_ hero: MediaItem) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Featured · Just added").eyebrow()
            Text(hero.title)
                .font(.horizon(size: 68, weight: .heavy))
                .kerning(-2.04)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.6), radius: 24, y: 6)
                .lineLimit(2)

            HStack(spacing: 12) {
                if let y = hero.year { Text("\(String(y))").foregroundStyle(.horizonMutedHi) }
                dot
                Text("\(Int(hero.duration / 60)) min").foregroundStyle(.horizonMutedHi)
                if hero.hdr.dv {
                    dot
                    badge("Dolby Vision")
                }
                dot
                Text(hero.videoCodec.uppercased()).foregroundStyle(.horizonMutedHi)
            }
            .font(.horizon(size: 13, weight: .regular))

            if let overview = hero.metadata?.overview {
                Text(overview)
                    .font(.horizon(size: 15, weight: .regular))
                    .foregroundStyle(Color.horizonTextSoft)
                    .lineLimit(3)
                    .frame(maxWidth: 540, alignment: .leading)
                    .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
            }

            HStack(spacing: 12) {
                NavigationLink(value: Route.play(hero.id)) {
                    HStack(spacing: 10) {
                        Image(systemName: "play.fill").font(.system(size: 14, weight: .heavy))
                        Text("Play").font(.horizon(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.black)
                    .padding(.horizontal, 28)
                    .frame(height: 52)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)

                NavigationLink(value: Route.play(hero.id)) {
                    HStack(spacing: 10) {
                        Image(systemName: "info.circle").font(.system(size: 14, weight: .semibold))
                        Text("More info").font(.horizon(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 24)
                    .frame(height: 52)
                    .background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.22))
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 8)
        }
    }

    private var dot: some View {
        Text("·").foregroundStyle(Color(white: 0.25))
    }
    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.horizon(size: 11, weight: .bold))
            .kerning(0.66)
            .foregroundStyle(.white)
            .padding(.horizontal, 8).padding(.vertical, 1)
            .overlay(
                RoundedRectangle(cornerRadius: 3).strokeBorder(Color.horizonBorderHi)
            )
    }

    // MARK: - Continue Watching rail

    private var continueWatchingRail: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Continue watching")
                .font(.horizon(size: 22, weight: .bold))
                .kerning(-0.33)
                .foregroundStyle(.white)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 16) {
                    ForEach(cwItems) { item in
                        NavigationLink(value: Route.play(item.mediaId)) {
                            LandscapeCard(item: item, width: 300, onTap: {})
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 8)
            }
        }
    }

    // MARK: - Tabs + grid

    private var sectionHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(tab.rawValue == "Home" ? "Movies" : tab.rawValue)
                .font(.horizon(size: 36, weight: .heavy))
                .kerning(-1.08)
                .foregroundStyle(.white)
            Text(gridSummary)
                .font(.horizon(size: 13, weight: .regular))
                .foregroundStyle(.horizonMutedHi)
        }
    }

    private var gridSummary: String {
        switch tab {
        case .movies, .home: return "\(movies.count) titles · last scan moments ago"
        case .series:        return "\(shows.count) titles · last scan moments ago"
        case .collections:   return "\(collections.count) sets"
        }
    }

    private var tabPills: some View {
        HStack(spacing: 8) {
            ForEach([TabKey.movies, .series, .collections], id: \.self) { t in
                Button {
                    tab = t
                } label: {
                    Text(t.rawValue)
                        .font(.horizon(size: 13, weight: tab == t ? .bold : .semibold))
                        .foregroundStyle(tab == t ? Color.horizonAccent : .white)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background(
                            Capsule().fill(tab == t ? Color.horizonAccentDim : Color.white.opacity(0.06))
                        )
                        .overlay(
                            Capsule().strokeBorder(
                                tab == t ? Color.horizonAccent.opacity(0.4) : Color.horizonBorder
                            )
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var grid: some View {
        if loading {
            Text("Loading library…")
                .font(.horizon(size: 14, weight: .regular))
                .foregroundStyle(.horizonMutedHi)
                .padding(.top, 16)
        } else {
            switch tab {
            case .home, .movies:
                if movies.isEmpty {
                    emptyText("No movies found. Check HORIZON_MOVIES_ROOT.")
                } else {
                    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 28) {
                        ForEach(movies) { m in
                            NavigationLink(value: Route.play(m.id)) {
                                LargePoster(source: .movie(m), width: 180, showMeta: true, onTap: {})
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            case .series:
                if shows.isEmpty {
                    emptyText("No shows found. Check HORIZON_SHOWS_ROOT.")
                } else {
                    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 28) {
                        ForEach(shows) { s in
                            NavigationLink(value: Route.show(s.id)) {
                                LargePoster(source: .show(s), width: 180, showMeta: true, onTap: {})
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            case .collections:
                if collections.isEmpty {
                    emptyText("No collections detected.")
                } else {
                    VStack(alignment: .leading, spacing: 40) {
                        ForEach(collections) { col in
                            VStack(alignment: .leading, spacing: 14) {
                                Text(col.name)
                                    .font(.horizon(size: 20, weight: .bold))
                                    .foregroundStyle(.white)
                                LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 28) {
                                    ForEach(col.movies) { m in
                                        NavigationLink(value: Route.play(m.id)) {
                                            LargePoster(source: .movie(m), width: 170, showMeta: true, onTap: {})
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var gridColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 180, maximum: 220), spacing: 24, alignment: .leading)]
    }

    private func emptyText(_ t: String) -> some View {
        Text(t)
            .font(.horizon(size: 14, weight: .regular))
            .foregroundStyle(.horizonMutedHi)
    }

    // MARK: - Load

    private func load() async {
        loading = true
        async let m  = try? client.api.listMovies()
        async let sh = try? client.api.listShows()
        async let co = try? client.api.listCollections()
        async let cw: [ContinueWatchingItem]? = {
            guard let id = client.activeUser?.id else { return nil }
            return try? await client.api.continueWatching(userId: id)
        }()
        let (mv, sv, cv, cwv) = await (m, sh, co, cw)
        await MainActor.run {
            self.movies = mv ?? []
            self.shows = sv ?? []
            self.collections = cv ?? []
            self.cwItems = cwv ?? []
            self.loading = false
        }
    }
}
