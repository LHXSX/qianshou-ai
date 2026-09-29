/** Static AppKit scene. Task text is passed as bounded argv data, never inserted into this source. */
export const DRAWN_VIDEO_SWIFT = String.raw`import AppKit
import Foundation

let width = 1280
let height = 720
let frameCount = 120
let fps = 24
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let textData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
guard let textFields = try JSONSerialization.jsonObject(with: textData) as? [String: String],
      let title = textFields["title"], let subtitle = textFields["subtitle"] else {
  fatalError("Invalid text fields")
}
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func color(_ hex: Int, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
          green: CGFloat((hex >> 8) & 255) / 255,
          blue: CGFloat(hex & 255) / 255,
          alpha: alpha)
}

func fill(_ rect: NSRect, _ shade: NSColor) {
  shade.setFill()
  NSBezierPath(rect: rect).fill()
}

func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat, _ shade: NSColor) {
  shade.setFill()
  NSBezierPath(ovalIn: NSRect(x: x - radius, y: y - radius,
                             width: radius * 2, height: radius * 2)).fill()
}

func ellipse(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, _ shade: NSColor) {
  shade.setFill()
  NSBezierPath(ovalIn: NSRect(x: x, y: y, width: width, height: height)).fill()
}

func polygon(_ points: [NSPoint], _ shade: NSColor) {
  guard let first = points.first else { return }
  let path = NSBezierPath()
  path.move(to: first)
  for point in points.dropFirst() { path.line(to: point) }
  path.close()
  shade.setFill()
  path.fill()
}

func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat,
          _ shade: NSColor, _ width: CGFloat = 1) {
  let path = NSBezierPath()
  path.move(to: NSPoint(x: x1, y: y1))
  path.line(to: NSPoint(x: x2, y: y2))
  path.lineWidth = width
  path.lineCapStyle = .round
  shade.setStroke()
  path.stroke()
}

func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat,
          _ weight: NSFont.Weight, _ shade: NSColor) {
  let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: shade,
  ]
  (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: attributes)
}

func wave(_ y: CGFloat, _ seconds: Double, _ index: Int) {
  let path = NSBezierPath()
  let shift = CGFloat(seconds * (12 + Double(index) * 3))
  path.move(to: NSPoint(x: 0, y: y))
  for x in stride(from: CGFloat(0), through: CGFloat(width), by: 12) {
    let v = y + sin((x + shift) / 52 + CGFloat(index)) * CGFloat(4 + index)
    path.line(to: NSPoint(x: x, y: v))
  }
  path.lineWidth = 2
  color(0xC7F6ED, 0.14 + CGFloat(index) * 0.025).setStroke()
  path.stroke()
}

func bicycle(_ x: CGFloat, _ seconds: Double) {
  let rear = x - 70
  let front = x + 72
  let ground: CGFloat = 182
  let radius: CGFloat = 54
  let crankY: CGFloat = 217
  let frame = color(0xF8D6A6)
  let plumage = color(0x182B32)
  let wing = color(0x2B4148)
  let bill = color(0xD9AA68)
  let phase = CGFloat(seconds * 8)

  circle(x + 8, 113, 123, color(0x183E45, 0.13))
  for center in [rear, front] {
    circle(center, ground, radius + 5, color(0x10313B))
    circle(center, ground, radius - 2, color(0xD9F7ED))
    circle(center, ground, radius - 7, color(0x16576A))
    for spoke in 0..<12 {
      let angle = CGFloat(spoke) * .pi / 6 + phase
      line(center, ground, center + cos(angle) * (radius - 8),
           ground + sin(angle) * (radius - 8), color(0xB8E7D8, 0.7), 1.4)
    }
    circle(center, ground, 6, color(0xF9D398))
  }

  line(rear, ground, x - 20, 267, frame, 9)
  line(x - 20, 267, x + 4, crankY, frame, 9)
  line(x + 4, crankY, rear, ground, frame, 9)
  line(x + 4, crankY, front, ground, frame, 9)
  line(front, ground, x + 43, 267, frame, 9)
  line(x + 43, 267, x - 20, 267, frame, 9)
  line(x - 36, 274, x + 1, 274, color(0x143A42), 8)
  line(x + 43, 267, x + 52, 287, frame, 6)
  line(x + 52, 287, x + 78, 287, plumage, 6)
  circle(x + 4, crankY, 12, color(0xEAAF6F))

  let footX = x + 4 + cos(phase) * 24
  let footY = crankY + sin(phase) * 24
  let otherFootX = x + 4 - cos(phase) * 24
  let otherFootY = crankY - sin(phase) * 24
  // Two pedalling legs and broad webbed feet remain behind the bird's body.
  line(x - 17, 297, footX, footY, plumage, 11)
  line(x + 7, 299, otherFootX, otherFootY, plumage, 11)
  for (pedalX, pedalY) in [(footX, footY), (otherFootX, otherFootY)] {
    polygon([NSPoint(x: pedalX - 9, y: pedalY - 8),
             NSPoint(x: pedalX + 15, y: pedalY - 5),
             NSPoint(x: pedalX + 17, y: pedalY + 3),
             NSPoint(x: pedalX - 5, y: pedalY + 5)], bill)
    for toe in 0..<3 {
      line(pedalX + 8, pedalY - 3, pedalX + 18 + CGFloat(toe) * 2,
           pedalY - 8 + CGFloat(toe) * 4, color(0xC59455), 2)
    }
  }

  // A cormorant silhouette: forked feather tail, heavy dark body, folded wing,
  // upright S-shaped long neck, narrow pointed bill and a pale throat patch.
  for feather in 0..<3 {
    line(x - 44, 322 + CGFloat(feather) * 3,
         x - 88 - CGFloat(feather) * 3, 327 + CGFloat(feather) * 11,
         color(0x213840), 7)
  }
  ellipse(x - 53, 291, 103, 67, plumage)
  ellipse(x - 30, 300, 68, 46, wing)
  for feather in 0..<4 {
    line(x - 17 + CGFloat(feather) * 10, 307,
         x - 8 + CGFloat(feather) * 10, 333,
         color(0x71868A, 0.54), 2)
  }
  let neck = NSBezierPath()
  neck.move(to: NSPoint(x: x + 24, y: 335))
  neck.curve(to: NSPoint(x: x + 43, y: 385),
             controlPoint1: NSPoint(x: x + 60, y: 339),
             controlPoint2: NSPoint(x: x + 17, y: 378))
  neck.lineWidth = 22
  neck.lineCapStyle = .round
  plumage.setStroke()
  neck.stroke()
  line(x + 46, 352, x + 58, 379, color(0x6B8284, 0.54), 3)
  ellipse(x + 35, 378, 38, 27, plumage)
  ellipse(x + 54, 378, 17, 10, color(0xDBD1B2))
  polygon([NSPoint(x: x + 69, y: 390), NSPoint(x: x + 108, y: 384),
           NSPoint(x: x + 72, y: 380)], bill)
  polygon([NSPoint(x: x + 104, y: 386), NSPoint(x: x + 111, y: 382),
           NSPoint(x: x + 106, y: 375)], color(0xC08E51))
  circle(x + 59, 396, 4.5, color(0xE5E4CB))
  circle(x + 60, 396, 2, color(0x0A171D))
  // The leading wing tips rest on the handlebar rather than forming human arms.
  line(x + 24, 315, x + 59, 288, wing, 13)
  line(x + 59, 288, x + 75, 285, plumage, 7)
  for feather in 0..<3 {
    line(x + 36 + CGFloat(feather) * 5, 305,
         x + 47 + CGFloat(feather) * 7, 291,
         color(0x60787B), 2)
  }
}

for frame in 0..<frameCount {
  let seconds = Double(frame) / Double(fps)
  guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
                                     pixelsWide: width, pixelsHigh: height,
                                     bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
        let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot allocate frame")
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = graphics
  let canvas = NSRect(x: 0, y: 0, width: width, height: height)
  NSGradient(starting: color(0x90CFC7), ending: color(0xFFD4A0))!
    .draw(in: canvas, angle: -15)

  circle(964, 529, 135, color(0xFFEEBF, 0.08))
  circle(964, 529, 102, color(0xFFEDB6, 0.13))
  circle(964, 529, 68, color(0xFFE8AB, 0.92))
  for (i, position) in [(0, 143), (1, 404), (2, 730)] {
    let cloudX = CGFloat(position) + CGFloat(seconds * Double(5 + i * 3))
    let cloudY = CGFloat(541 - i * 23)
    circle(cloudX, cloudY, 26, color(0xFFFFFF, 0.44))
    circle(cloudX + 32, cloudY + 11, 38, color(0xFFFFFF, 0.44))
    circle(cloudX + 75, cloudY, 29, color(0xFFFFFF, 0.44))
  }

  NSGradient(starting: color(0x3D9A9D), ending: color(0x1D6C83))!
    .draw(in: NSRect(x: 0, y: 243, width: width, height: 161), angle: -90)
  line(0, 405, CGFloat(width), 405, color(0xEFF6D6, 0.72), 3)
  for index in 0..<9 { wave(CGFloat(256 + index * 17), seconds, index) }
  NSGradient(starting: color(0xF6D69D), ending: color(0xD8AF7E))!
    .draw(in: NSRect(x: 0, y: 0, width: width, height: 245), angle: -90)
  let shoreline = NSBezierPath()
  shoreline.move(to: NSPoint(x: 0, y: 238))
  for x in stride(from: CGFloat(0), through: CGFloat(width), by: 12) {
    let y = 240 + sin((x + CGFloat(seconds * 13)) / 110) * 9
    shoreline.line(to: NSPoint(x: x, y: y))
  }
  shoreline.lineWidth = 11
  color(0xFFF7DD, 0.75).setStroke()
  shoreline.stroke()
  fill(NSRect(x: 0, y: 102, width: width, height: 10), color(0xC7956B, 0.37))
  fill(NSRect(x: 0, y: 104, width: width, height: 4), color(0xFFF5D0, 0.7))

  let position = CGFloat(263 + 655 * Double(frame) / Double(frameCount - 1))
  bicycle(position, seconds)
  fill(NSRect(x: 63, y: 545, width: 7, height: 99), color(0x164C52))
  text(title, 90, 591, 48, .bold, color(0x153B43))
  text(subtitle, 93, 555, 21, .medium, color(0x2B5E63))
  line(76, 62, 1204, 62, color(0x306B6C, 0.48), 1)
  text("QIANSHOU  /  LOCAL DRAWN MOTION", 78, 30, 14, .semibold, color(0x25565B))
  text("05 SEC  ·  24 FPS", 1064, 30, 14, .medium, color(0x25565B))

  graphics.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode frame")
  }
  try png.write(to: output.appendingPathComponent(String(format: "frame_%03d.png", frame)))
}
`
