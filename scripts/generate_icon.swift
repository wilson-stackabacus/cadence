// Renders the Cadence app icon at every macOS size into an AppIcon.appiconset.
// usage: swift scripts/generate_icon.swift Sources/Assets.xcassets
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("AppIcon.appiconset")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // macOS icon grid: content inset ~10%, squircle-ish corner radius.
    let inset = s * 0.1
    let rect = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = CGPath(roundedRect: rect, cornerWidth: rect.width * 0.225, cornerHeight: rect.width * 0.225, transform: nil)

    // Drop shadow + gradient body (sunrise coral → violet).
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.35).cgColor)
    ctx.addPath(path); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(path); ctx.clip()
    let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        NSColor(red: 1.00, green: 0.55, blue: 0.36, alpha: 1).cgColor,
        NSColor(red: 0.89, green: 0.33, blue: 0.55, alpha: 1).cgColor,
        NSColor(red: 0.42, green: 0.30, blue: 0.86, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 0.5, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: rect.minX, y: rect.maxY), end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
    // Soft highlight in the top half.
    ctx.setFillColor(NSColor.white.withAlphaComponent(0.08).cgColor)
    ctx.fillEllipse(in: CGRect(x: rect.minX - rect.width * 0.2, y: rect.midY, width: rect.width * 1.4, height: rect.height))
    ctx.restoreGState()

    let c = CGPoint(x: s / 2, y: s / 2)
    let r = rect.width * 0.29
    let lw = rect.width * 0.075

    // Track ring, then a progress arc (~75%) with round caps.
    ctx.setLineCap(.round)
    ctx.setLineWidth(lw)
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.28).cgColor)
    ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.addArc(center: c, radius: r, startAngle: .pi / 2, endAngle: .pi / 2 - 1.5 * .pi, clockwise: true)
    ctx.strokePath()

    // Dot at the end of the arc, like a clock hand tip.
    let end = CGPoint(x: c.x + r * cos(.pi / 2 - 1.5 * .pi), y: c.y + r * sin(.pi / 2 - 1.5 * .pi))
    ctx.setFillColor(NSColor(red: 1.0, green: 0.86, blue: 0.45, alpha: 1).cgColor)
    ctx.fillEllipse(in: CGRect(x: end.x - lw * 0.75, y: end.y - lw * 0.75, width: lw * 1.5, height: lw * 1.5))

    // Checkmark in the middle.
    ctx.setLineJoin(.round)
    ctx.setLineWidth(lw * 0.95)
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.move(to: CGPoint(x: c.x - r * 0.45, y: c.y + r * 0.02))
    ctx.addLine(to: CGPoint(x: c.x - r * 0.1, y: c.y - r * 0.33))
    ctx.addLine(to: CGPoint(x: c.x + r * 0.5, y: c.y + r * 0.35))
    ctx.strokePath()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

var images: [[String: String]] = []
for pt in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "icon_\(pt)x\(pt)\(scale == 2 ? "@2x" : "").png"
        try! render(pt * scale).write(to: out.appendingPathComponent(name))
        images.append(["idiom": "mac", "size": "\(pt)x\(pt)", "scale": "\(scale)x", "filename": name])
    }
}
let contents: [String: Any] = ["images": images, "info": ["version": 1, "author": "xcode"]]
try! JSONSerialization.data(withJSONObject: contents, options: .prettyPrinted).write(to: out.appendingPathComponent("Contents.json"))
let root = out.deletingLastPathComponent().appendingPathComponent("Contents.json")
try! #"{"info":{"version":1,"author":"xcode"}}"#.write(to: root, atomically: true, encoding: .utf8)

print("wrote", out.path)
