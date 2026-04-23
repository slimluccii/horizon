import SwiftUI

/// First-run flow: no users on the server → create the first profile.
/// Matches the web Setup.tsx in layout, palette, and copy.
struct SetupView: View {
    @Environment(HorizonClient.self) private var client

    @State private var name: String = ""
    @State private var avatar: String? = nil
    @State private var busy = false
    @State private var error: String? = nil

    private let avatars = ["🐱","🐶","🦊","🐼","🐸","🚀","🎮","🎬","🎨","👤"]

    var body: some View {
        ZStack {
            Color.horizonBgDeep.ignoresSafeArea()

            // Atmospheric radial glows — echoes web Setup.css bg layer.
            RadialGradient(colors: [Color.horizonAccent.opacity(0.16), .clear],
                           center: UnitPoint(x: 0.25, y: 0.2),
                           startRadius: 0, endRadius: 600)
            RadialGradient(colors: [Color(red: 227/255, green: 73/255, blue: 137/255).opacity(0.1), .clear],
                           center: UnitPoint(x: 0.8, y: 0.85),
                           startRadius: 0, endRadius: 600)

            VStack(spacing: 40) {
                HorizonMark(size: 56, withText: true)

                VStack(alignment: .leading, spacing: 0) {
                    Text("First run · new library").eyebrow()
                    Text("Welcome to Horizon")
                        .font(.horizon(size: 36, weight: .heavy))
                        .kerning(-1.08)
                        .foregroundStyle(.white)
                        .padding(.top, 12)
                    Text("Create a profile to start watching.")
                        .font(.horizon(size: 14, weight: .regular))
                        .foregroundStyle(.horizonMutedHi)
                        .padding(.top, 4)
                        .padding(.bottom, 24)

                    fieldLabel("Name")
                    TextField("Luuk", text: $name)
                        .textFieldStyle(.plain)
                        .font(.horizon(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .background(Color.horizonSurface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .strokeBorder(Color.horizonBorderHi)
                        )
                        .padding(.bottom, 20)

                    fieldLabel("Avatar")
                    HStack(spacing: 8) {
                        ForEach(avatars, id: \.self) { a in
                            Button {
                                avatar = (a == avatar) ? nil : a
                            } label: {
                                Text(a)
                                    .font(.system(size: 22))
                                    .frame(width: 44, height: 44)
                                    .background(Color.horizonSurface, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 10)
                                            .strokeBorder(avatar == a ? Color.horizonAccent : Color.horizonBorder,
                                                          lineWidth: avatar == a ? 2 : 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, 16)

                    if let error {
                        Text(error)
                            .font(.horizon(size: 13, weight: .semibold))
                            .foregroundStyle(.horizonDanger)
                            .padding(.bottom, 12)
                    }

                    Button(action: submit) {
                        HStack(spacing: 10) {
                            if busy {
                                ProgressView().progressViewStyle(.circular).controlSize(.small)
                            } else {
                                Text("Get started")
                                    .font(.horizon(size: 16, weight: .bold))
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                        }
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(Color.horizonAccent, in: RoundedRectangle(cornerRadius: 10))
                        .shadow(color: .horizonAccent.opacity(0.66), radius: 20, y: 10)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
                }
                .frame(width: 440)
                .padding(.horizontal, 36)
                .padding(.vertical, 40)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Color(red: 10/255, green: 22/255, blue: 34/255).opacity(0.78))
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(Color.horizonBorder)
                )
                .shadow(color: .black.opacity(0.5), radius: 40, y: 40)

                Text("HORIZON.LOCAL · SELF-HOSTED MEDIA")
                    .font(.horizon(size: 11, weight: .bold))
                    .kerning(1.5)
                    .foregroundStyle(.horizonMuted)
            }
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.horizon(size: 11, weight: .bold))
            .kerning(1.8)
            .textCase(.uppercase)
            .foregroundStyle(.horizonMuted)
            .padding(.bottom, 8)
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { error = "Name required"; return }
        busy = true; error = nil
        Task {
            do {
                let u = try await client.api.createUser(name: trimmed, avatar: avatar)
                await client.reloadUsers()
                await MainActor.run {
                    client.setActiveUser(u)
                    busy = false
                }
            } catch let e as APIError {
                await MainActor.run {
                    error = (e.code == "name-taken") ? "That name is already in use" : (e.message ?? "Unknown error")
                    busy = false
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    busy = false
                }
            }
        }
    }
}
