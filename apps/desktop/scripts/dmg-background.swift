import AppKit

// Run with Swift on macOS after changing the installer artwork or public/logo.png.
let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = desktop.appendingPathComponent("src-tauri/resources/dmg-background.tiff")
let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: scratch) }
guard let logo = NSImage(contentsOf: desktop.appendingPathComponent("public/logo.png")) else {
    fatalError("Missing TRAWL logo")
}
let width = 660, height = 420
let green = NSColor(srgbRed: 0.25, green: 0.79, blue: 0.56, alpha: 1)
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current!.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    NSColor(srgbRed: 0.075, green: 0.075, blue: 0.085, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    for x in [80, 380] {
        let panel = NSBezierPath(roundedRect: NSRect(x: x, y: 94, width: 200, height: 216), xRadius: 22, yRadius: 22)
        NSColor(srgbRed: 0.93, green: 0.93, blue: 0.95, alpha: 1).setFill()
        panel.fill()
        NSColor(srgbRed: 0.98, green: 0.98, blue: 0.99, alpha: 1).setStroke()
        panel.lineWidth = 1
        panel.stroke()
    }
    let title = NSMutableAttributedString(string: "trawl.", attributes: [
        .font: NSFont.systemFont(ofSize: 34, weight: .semibold), .foregroundColor: NSColor.white,
    ])
    title.addAttribute(.foregroundColor, value: green, range: NSRange(location: 5, length: 1))
    let left = (CGFloat(width) - 44 - 12 - title.size().width) / 2
    logo.draw(in: NSRect(x: left, y: 334, width: 44, height: 44))
    title.draw(at: NSPoint(x: left + 56, y: 335))

    green.setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 298, y: 215)); arrow.line(to: NSPoint(x: 358, y: 215))
    arrow.move(to: NSPoint(x: 348, y: 225)); arrow.line(to: NSPoint(x: 358, y: 215)); arrow.line(to: NSPoint(x: 348, y: 205))
    arrow.stroke()

    let hint = NSAttributedString(string: "Drag TRAWL to Applications", attributes: [
        .font: NSFont.systemFont(ofSize: 15, weight: .medium),
        .foregroundColor: NSColor(srgbRed: 0.81, green: 0.81, blue: 0.84, alpha: 1),
    ])
    hint.draw(at: NSPoint(x: (CGFloat(width) - hint.size().width) / 2, y: 41))
    NSGraphicsContext.restoreGraphicsState()
    bitmap.size = NSSize(width: width, height: height)
    let data = bitmap.representation(using: .tiff, properties: [.compressionMethod: NSNumber(value: NSBitmapImageRep.TIFFCompression.lzw.rawValue)])!
    try data.write(to: scratch.appendingPathComponent("background-\(scale).tiff"))
}
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
let combine = Process()
combine.executableURL = URL(fileURLWithPath: "/usr/bin/tiffutil")
combine.arguments = ["-cathidpicheck", scratch.appendingPathComponent("background-1.tiff").path,
    scratch.appendingPathComponent("background-2.tiff").path, "-out", output.path]
try combine.run()
combine.waitUntilExit()
guard combine.terminationStatus == 0 else { fatalError("Cannot create Retina installer background") }
print(output.path)
