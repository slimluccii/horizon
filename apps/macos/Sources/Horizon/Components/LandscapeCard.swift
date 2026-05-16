import SwiftUI

/// 16:9 card used on the Continue Watching rail. Backdrop / episode still +
/// bottom gradient overlay + title + progress bar. Plain View (no Button) so
/// the outer NavigationLink receives taps.
struct LandscapeCard: View {
    let item: ContinueWatchingItem
    var width: CGFloat = 300

    @State private var hovering = false

    private var imageURL: URL? {
        if item.kind == "episode" {
            if let still = TmdbImage.url(item.media.metadata?.stillPath, size: .w500) { return still }
            if let back  = TmdbImage.url(item.show?.metadata?.backdropPath, size: .w500) { return back }
        }
        if let back = TmdbImage.url(item.media.metadata?.backdropPath, size: .w500) { return back }
        return TmdbImage.url(item.media.metadata?.posterPath, size: .w342)
    }

    private var title: String {
        if item.kind == "episode", let show = item.show { return show.title }
        return item.media.title
    }

    private var subtitle: String {
        var parts: [String] = []
        if item.kind == "episode",
           let s = item.media.season, let e = item.media.episode {
            parts.append(String(format: "S%02dE%02d", s, e))
            parts.append(item.media.title)
        }
        let remaining = max(0, Int(((item.durationMs - item.positionMs)) / 60_000))
        parts.append("\(remaining) min left")
        return parts.joined(separator: " · ")
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.horizonSurface)
                if let url = imageURL {
                    AsyncImage(url: url) { phase in
                        if case .success(let img) = phase {
                            img.resizable().aspectRatio(contentMode: .fill)
                        }
                    }
                }
                LinearGradient(colors: [.clear, .black.opacity(0.85)],
                               startPoint: .top, endPoint: .bottom)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.horizon(size: 15, weight: .bold))
                    .kerning(-0.15)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .shadow(color: .black.opacity(0.6), radius: 4, y: 2)
                Text(subtitle)
                    .font(.horizon(size: 12, weight: .regular))
                    .foregroundStyle(.horizonMutedHi)
                    .lineLimit(1)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 18)

            // Progress bar pinned to the bottom of the image.
            VStack {
                Spacer()
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color.white.opacity(0.2))
                        .frame(height: 3)
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color.horizonAccent)
                        .frame(width: CGFloat(item.percent) / 100.0 * (width - 24), height: 3)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
        .frame(width: width, height: width * 9 / 16)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .shadow(color: .black.opacity(hovering ? 0.6 : 0.45),
                radius: hovering ? 24 : 12, x: 0, y: hovering ? 20 : 12)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(hovering ? Color.horizonAccent : Color.white.opacity(0.04),
                              lineWidth: hovering ? 2 : 1)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .offset(y: hovering ? -4 : 0)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: hovering)
    }
}
