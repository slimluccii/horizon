import SwiftUI

/// 2:3 poster tile. Hover lift + accent focus ring match the web `LargePoster`.
struct LargePoster: View {
    enum Source {
        case movie(MediaItem)
        case show(ShowSummary)
    }

    let source: Source
    var width: CGFloat = 180
    var showMeta: Bool = false
    var onTap: () -> Void

    @State private var hovering = false

    private var posterURL: URL? {
        switch source {
        case .movie(let m): return TmdbImage.url(m.metadata?.posterPath, size: .w342)
        case .show(let s):  return TmdbImage.url(s.metadata?.posterPath,  size: .w342)
        }
    }

    private var title: String {
        switch source {
        case .movie(let m): return m.title
        case .show(let s):  return s.title
        }
    }

    private var subtitle: String {
        switch source {
        case .movie(let m):
            let mins = Int((m.duration / 60).rounded())
            if let y = m.year { return "\(y) · \(mins)m" }
            return "\(mins)m"
        case .show(let s):
            let eps = s.seasons.reduce(0) { $0 + $1.episodeCount }
            return "\(s.seasons.count) season\(s.seasons.count == 1 ? "" : "s") · \(eps) ep"
        }
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: max(6, width * 0.05), style: .continuous)
                        .fill(Color.horizonSurface)
                    if let url = posterURL {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().aspectRatio(contentMode: .fill)
                            default:
                                posterFallback
                            }
                        }
                    } else {
                        posterFallback
                    }
                    if case .show = source {
                        VStack {
                            HStack {
                                Spacer()
                                Text("SERIES")
                                    .font(.horizon(size: 10, weight: .heavy))
                                    .kerning(1.2)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 3))
                                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 3))
                                    .padding(10)
                            }
                            Spacer()
                        }
                    }
                }
                .frame(width: width, height: width * 1.5)
                .clipShape(RoundedRectangle(cornerRadius: max(6, width * 0.05), style: .continuous))
                .shadow(color: .black.opacity(hovering ? 0.6 : 0.45), radius: hovering ? 24 : 12, x: 0, y: hovering ? 20 : 12)
                .overlay(
                    RoundedRectangle(cornerRadius: max(6, width * 0.05), style: .continuous)
                        .strokeBorder(hovering ? Color.horizonAccent : Color.white.opacity(0.04),
                                      lineWidth: hovering ? 2 : 1)
                )
                if showMeta {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.horizon(size: 14, weight: .bold))
                            .kerning(-0.14)
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.horizon(size: 12, weight: .regular))
                            .foregroundStyle(.horizonMutedHi)
                    }
                    .frame(width: width, alignment: .leading)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .scaleEffect(hovering ? 1.02 : 1.0)
        .offset(y: hovering ? -4 : 0)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: hovering)
    }

    private var posterFallback: some View {
        ZStack {
            LinearGradient(
                colors: [Color.horizonSurface2, Color.horizonSurface],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            Text("NO POSTER")
                .font(.horizon(size: 11, weight: .heavy))
                .kerning(1.5)
                .foregroundStyle(.horizonMuted)
        }
    }
}
