import AppKit
import SwiftUI
import UserNotifications

/// What an alert says, independent of how it is delivered.
struct AlertContent {
    enum Kind: String { case task, nudge, checkIn, event, test }
    var kind: Kind
    var title: String
    var body: String
    var symbol: String = "checklist"
    var tint: Color = .accentColor
    var occurrence: Occurrence?
}

/// Delivers alerts through whichever channels were chosen (Notification Center,
/// on-screen banner, sound, checklist window).
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private let center = UNUserNotificationCenter.current()
    private(set) var authorized = false
    weak var model: AppModel?

    func setup(model: AppModel) {
        self.model = model
        center.delegate = self
        let open = UNNotificationAction(identifier: "OPEN", title: "Open checklist", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "CADENCE", actions: [open], intentIdentifiers: [], options: [])
        ])
        Task { await requestAuthorization() }
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        authorized = granted
        return granted
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        let status = await center.notificationSettings().authorizationStatus
        authorized = status == .authorized || status == .provisional
        return status
    }

    func deliver(_ content: AlertContent, channels: Set<AlertChannel>) {
        let settings = model?.store.settings ?? AppSettings()
        var channels = channels
        // If macOS notifications are blocked, fall back to our own banner so nothing is silently lost.
        if channels.contains(.notification) && !authorized { channels.insert(.banner) }

        if channels.contains(.notification) && authorized {
            let c = UNMutableNotificationContent()
            c.title = content.title
            c.body = content.body
            c.categoryIdentifier = "CADENCE"
            c.threadIdentifier = content.kind.rawValue
            c.sound = channels.contains(.sound) ? .default : nil
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
            center.add(req)
        } else if channels.contains(.sound) {
            NSSound(named: "Glass")?.play()
        }

        if channels.contains(.banner) {
            BannerCenter.shared.show(content, autoDismiss: settings.bannerAutoDismissSeconds)
        }
        if channels.contains(.checkIn) {
            model?.windows.showCheckIn(reason: content.title)
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { AppModel.shared.openChecklist() }
        }
        completionHandler()
    }
}

// MARK: - On-screen banners

/// Floating, non-activating panels stacked in the top-right corner of the screen.
@MainActor
final class BannerCenter {
    static let shared = BannerCenter()
    private var panels: [NSPanel] = []
    private let size = NSSize(width: 380, height: 112)

    func show(_ content: AlertContent, autoDismiss: Int) {
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                            styleMask: [.nonactivatingPanel, .borderless],
                            backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false

        let view = BannerView(content: content,
                              onOpen: { [weak self, weak panel] in
                                  if let panel { self?.dismiss(panel) }
                                  if let occ = content.occurrence, !occ.isResolved {
                                      AppModel.shared.beginReflection(occ)
                                  } else {
                                      AppModel.shared.openChecklist()
                                  }
                              },
                              onDismiss: { [weak self, weak panel] in
                                  if let panel { self?.dismiss(panel) }
                              })
        panel.contentView = NSHostingView(rootView: view)
        panels.insert(panel, at: 0)
        if panels.count > 4, let oldest = panels.last { dismiss(oldest) }
        layout()
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.2; panel.animator().alphaValue = 1 }

        if autoDismiss > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(autoDismiss)) { [weak self, weak panel] in
                if let panel { self?.dismiss(panel) }
            }
        }
    }

    func dismiss(_ panel: NSPanel) {
        guard let i = panels.firstIndex(of: panel) else { return }
        panels.remove(at: i)
        panel.orderOut(nil)
        layout()
    }

    func dismissAll() { panels.forEach { $0.orderOut(nil) }; panels.removeAll() }

    var visibleWindows: [NSWindow] { panels }

    private func layout() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let vf = screen.visibleFrame
        var y = vf.maxY - 12
        for p in panels {
            y -= size.height
            p.setFrame(NSRect(x: vf.maxX - size.width - 12, y: y, width: size.width, height: size.height),
                       display: true, animate: p.alphaValue > 0)
            y -= 8
        }
    }
}

struct BannerView: View {
    let content: AlertContent
    let onOpen: () -> Void
    let onDismiss: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: content.symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(content.tint.gradient))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("CADENCE").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text(Date(), style: .time).font(.caption2).foregroundStyle(.secondary)
                }
                Text(content.title).font(.headline).lineLimit(1)
                Text(content.body).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Dismiss", action: onDismiss).controlSize(.small)
                    Button(content.occurrence.map { $0.isResolved ? "Open checklist" : "Complete…" } ?? "Open checklist",
                           action: onOpen)
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(width: 380, height: 112, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.15)))
        .overlay(alignment: .topLeading) {
            if hovering {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 16)).symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.plain)
                .offset(x: -4, y: -4)
            }
        }
        .onHover { hovering = $0 }
    }
}
