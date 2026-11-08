// desktop-helper: the macOS side of the desktop MCP server. Each subcommand does one thing and
// prints one JSON line; errors go to stderr with exit 1. Coordinates are global display points
// (origin at the main display's top-left corner), the space CGEvent and CGDisplayBounds use.
//
//   permissions                         Screen Recording and Accessibility status
//   displays                            active displays, in points and pixels
//   frontmost                           the frontmost app
//   focused                             {app} that has keyboard focus, which can differ from the
//                                       frontmost app (Spotlight and other non-activating
//                                       panels), or {axError, frontmost} when the query fails
//   scene <x> <y>                       the windows at a point and the Accessibility hit-test
//                                       there, from which desktop.js picks the app
//   app-info <name or bundle id>        a running or installed app
//   screenshot <display id> <w> <h> <path>   JPEG of a display, scaled to w x h
//   move <x> <y>
//   click <x> <y> <left|right|middle> <count> [modifiers]
//   drag <x1> <y1> <x2> <y2> [modifiers]
//   scroll <x> <y> <dx> <dy>            in lines; positive dy scrolls up
//   type <text>
//   key <keycode> [modifiers]           modifiers: comma-separated cmd,ctrl,alt,shift,fn
//   overlay <parent pid> <stop file> <text>   stop panel; when the user stops (button or Esc) it
//                                       writes the stop file and exits 0; it exits 3 when the
//                                       parent is gone
//
// Input commands stop between steps, with exit 4, once the file named by DESKTOP_STOP_FILE
// exists, so a long typing or drag ends when the user presses Stop.
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import UniformTypeIdentifiers

// Marks the events this helper posts, so the overlay ignores its own Esc presses.
let MARK: Int64 = 0x4453_4B54

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func number(_ text: String) -> Double {
  guard let value = Double(text), value.isFinite else { fail("not a number: \(text)") }
  return value
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
  var info: [String: Any] = [
    "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "running": true,
  ]
  if let url = app.bundleURL { info.merge(bundleInfo(url)) { old, _ in old } }
  return info
}

func bundleInfo(_ url: URL) -> [String: Any] {
  var info: [String: Any] = ["path": url.path]
  if let bundle = Bundle(url: url) {
    if let id = bundle.bundleIdentifier { info["bundleId"] = id }
    if let category = bundle.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String { info["category"] = category }
    let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
    info["name"] = name ?? url.deletingPathExtension().lastPathComponent
  }
  return info
}

func displays() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return ids.prefix(Int(count)).enumerated().map { index, id in
    let bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
    let pixelHeight = mode?.pixelHeight ?? Int(bounds.height)
    return [
      "index": index, "id": Int(id), "main": CGDisplayIsMain(id) != 0,
      "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height,
      "pixelWidth": pixelWidth, "pixelHeight": pixelHeight, "scale": Double(pixelWidth) / bounds.width,
    ]
  }
}

func frontmost() -> [String: Any]? {
  NSWorkspace.shared.frontmostApplication.map(appInfo)
}

// The focused app, or the AX error code and the frontmost app when the query fails, in one
// call; desktop.js decides what a failure means.
func focused() -> [String: Any] {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value)
  guard error == .success else { return ["axError": Int(error.rawValue), "frontmost": frontmost() ?? NSNull()] }
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return ["app": NSNull()] }
  var pid: pid_t = 0
  guard AXUIElementGetPid(value as! AXUIElement, &pid) == .success,
        let app = NSRunningApplication(processIdentifier: pid) else { return ["app": NSNull()] }
  return ["app": appInfo(app)]
}

// What decides the app under a point, for chooseApp in desktop.js: the visible windows that
// contain it, front to back, the pid the Accessibility hit-test finds there (null when it
// fails), the Dock's window level and the display bounds.
func scene(_ point: CGPoint) -> [String: Any] {
  let rect = { (r: CGRect) -> [String: Any] in ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height] }
  var windows: [[String: Any]] = []
  for window in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
    guard let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict), bounds.contains(point) else { continue }
    let pid = window[kCGWindowOwnerPID as String] as? pid_t
    windows.append([
      "owner": window[kCGWindowOwnerName as String] as? String ?? "",
      "name": window[kCGWindowName as String] as? String ?? "",
      "layer": window[kCGWindowLayer as String] as? Int ?? 0,
      "alpha": window[kCGWindowAlpha as String] as? Double ?? 1,
      "bounds": rect(bounds),
      "pid": pid.map { Int($0) } ?? NSNull(),
      "app": pid.flatMap { NSRunningApplication(processIdentifier: $0) }.map(appInfo) ?? NSNull(),
    ])
  }
  // Only a Dock window at the Dock level uses the hit-test, so other points skip the AX call,
  // which waits for a busy app.
  let dockLevel = Int(CGWindowLevelForKey(.dockWindow))
  var hit = false
  var hitPid: pid_t = 0
  if windows.contains(where: { ($0["app"] as? [String: Any])?["bundleId"] as? String == "com.apple.dock" && $0["layer"] as? Int == dockLevel }) {
    let systemWide = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(systemWide, 1)
    var element: AXUIElement?
    hit = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element) == .success
      && element.map { AXUIElementGetPid($0, &hitPid) == .success } == true
  }
  let bounds = displays().map { $0.filter { ["x", "y", "width", "height"].contains($0.key) } }
  return [
    "windows": windows,
    "hitPid": hit ? Int(hitPid) : NSNull(),
    "dockLevel": dockLevel,
    "displays": bounds,
    "frontmost": frontmost() ?? NSNull(),
    "finder": NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first.map(appInfo) ?? NSNull(),
  ]
}

func findApp(_ query: String) -> [String: Any]? {
  let lower = query.lowercased()
  if let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower
  }) { return appInfo(app) }
  if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) { return bundleInfo(url) }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "\(home)/Applications"] {
    let url = URL(fileURLWithPath: dir).appendingPathComponent(query.hasSuffix(".app") ? query : "\(query).app")
    if FileManager.default.fileExists(atPath: url.path) { return bundleInfo(url) }
  }
  return nil
}

func screenshot(displayID: CGDirectDisplayID, width: Int, height: Int, path: String) {
  var failure: String?
  let done = DispatchSemaphore(value: 0)
  Task.detached {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        failure = "no display with id \(displayID)"
        done.signal()
        return
      }
      let config = SCStreamConfiguration()
      config.width = width
      config.height = height
      config.showsCursor = true
      let image = try await SCScreenshotManager.captureImage(
        contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
      guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
      else { throw NSError(domain: "desktop", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot write \(path)"]) }
      CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
      if !CGImageDestinationFinalize(dest) { failure = "cannot write \(path)" }
    } catch {
      failure = "screen capture failed: \(error.localizedDescription). Grant Screen Recording to the app that started Claude Code."
    }
    done.signal()
  }
  done.wait()
  if let failure { fail(failure) }
}

let source = CGEventSource(stateID: .hidSystemState)

func flags(_ text: String?) -> CGEventFlags {
  var result: CGEventFlags = []
  for name in (text ?? "").split(separator: ",") {
    switch name {
    case "cmd": result.insert(.maskCommand)
    case "ctrl": result.insert(.maskControl)
    case "alt": result.insert(.maskAlternate)
    case "shift": result.insert(.maskShift)
    case "fn": result.insert(.maskSecondaryFn)
    default: fail("unknown modifier: \(name)")
    }
  }
  return result
}

let stopFile = ProcessInfo.processInfo.environment["DESKTOP_STOP_FILE"]

func post(_ event: CGEvent?, _ mods: CGEventFlags = []) {
  if let stopFile, FileManager.default.fileExists(atPath: stopFile) {
    FileHandle.standardError.write(Data("stopped by the user\n".utf8))
    exit(4)
  }
  guard let event else { fail("could not create the event") }
  if !mods.isEmpty { event.flags = mods }
  event.setIntegerValueField(.eventSourceUserData, value: MARK)
  event.post(tap: .cghidEventTap)
}

func requireAccessibility() {
  if !AXIsProcessTrusted() { fail("input is not allowed. Grant Accessibility to the app that started Claude Code.") }
}

func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) -> CGEvent? {
  CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
}

func click(_ point: CGPoint, _ buttonName: String, _ count: Int, _ mods: CGEventFlags) {
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = switch buttonName {
  case "left": (.leftMouseDown, .leftMouseUp, .left)
  case "right": (.rightMouseDown, .rightMouseUp, .right)
  case "middle": (.otherMouseDown, .otherMouseUp, .center)
  default: fail("unknown button: \(buttonName)")
  }
  post(mouse(.mouseMoved, point))
  usleep(50_000)
  for clickState in 1...max(1, count) {
    for type in [down, up] {
      let event = mouse(type, point, button)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
      post(event, mods)
    }
    usleep(30_000)
  }
}

func drag(_ from: CGPoint, _ to: CGPoint, _ mods: CGEventFlags) {
  post(mouse(.mouseMoved, from))
  usleep(50_000)
  post(mouse(.leftMouseDown, from), mods)
  let steps = 12
  for step in 1...steps {
    let t = Double(step) / Double(steps)
    post(mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)), mods)
    usleep(15_000)
  }
  post(mouse(.leftMouseUp, to), mods)
}

func typeText(_ text: String) {
  for (index, line) in text.components(separatedBy: "\n").enumerated() {
    if index > 0 { pressKey(36, []) }
    // Chunks of whole characters, at most 16 UTF-16 units each, so a surrogate pair or a
    // combined emoji never splits across two events.
    var chunks: [[UniChar]] = [[]]
    for character in line {
      let units = Array(String(character).utf16)
      if chunks[chunks.count - 1].count + units.count > 16 && !chunks[chunks.count - 1].isEmpty { chunks.append([]) }
      chunks[chunks.count - 1] += units
    }
    for chunk in chunks where !chunk.isEmpty {
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(event)
      }
      usleep(10_000)
    }
  }
}

func pressKey(_ code: CGKeyCode, _ mods: CGEventFlags) {
  for down in [true, false] { post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down), mods) }
}

final class Overlay: NSObject, NSApplicationDelegate {
  let parent: pid_t
  let stopFile: String
  let text: String
  var panel: NSPanel?

  init(parent: pid_t, stopFile: String, text: String) {
    self.parent = parent
    self.stopFile = stopFile
    self.text = text
  }

  // The bottom-right corner of the main display, above the Dock, where app toolbars and
  // address bars are not.
  func applicationDidFinishLaunching(_ notification: Notification) {
    let frame = (NSScreen.screens.first ?? NSScreen.main!).visibleFrame
    let size = NSSize(width: 420, height: 44)
    let panel = NSPanel(
      contentRect: NSRect(x: frame.maxX - size.width - 12, y: frame.minY + 12, width: size.width, height: size.height),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    panel.backgroundColor = NSColor.black.withAlphaComponent(0.82)
    panel.isOpaque = false
    let label = NSTextField(labelWithString: text)
    label.textColor = .white
    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.frame = NSRect(x: 14, y: 13, width: 290, height: 18)
    let button = NSButton(title: "Stop (Esc)", target: self, action: #selector(stop))
    button.bezelStyle = .rounded
    button.frame = NSRect(x: 310, y: 8, width: 100, height: 28)
    panel.contentView?.addSubview(label)
    panel.contentView?.addSubview(button)
    panel.orderFrontRegardless()
    self.panel = panel
    NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [self] event in
      if event.keyCode == 53, event.cgEvent?.getIntegerValueField(.eventSourceUserData) != MARK { stop() }
    }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [parent] _ in
      if kill(parent, 0) != 0 { exit(3) }
    }
    emit(["ready": true])
  }

  @objc func stop() {
    FileManager.default.createFile(atPath: stopFile, contents: Data())
    exit(0)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: desktop-helper <command> ...") }
let rest = Array(args.dropFirst())
func arg(_ index: Int) -> String {
  guard index < rest.count else { fail("\(command): missing argument \(index + 1)") }
  return rest[index]
}
func point(_ index: Int) -> CGPoint { CGPoint(x: number(arg(index)), y: number(arg(index + 1))) }
func optional(_ index: Int) -> String? { index < rest.count && !rest[index].isEmpty ? rest[index] : nil }

switch command {
case "permissions":
  emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case "displays":
  emit(displays())
case "frontmost":
  emit(frontmost() ?? NSNull())
case "focused":
  requireAccessibility()
  emit(focused())
case "scene":
  requireAccessibility()
  emit(scene(point(0)))
case "app-info":
  emit(findApp(arg(0)) ?? NSNull())
case "screenshot":
  guard let id = UInt32(arg(0)), let width = Int(arg(1)), let height = Int(arg(2)) else { fail("screenshot: bad arguments") }
  screenshot(displayID: id, width: width, height: height, path: arg(3))
  emit(["path": arg(3), "width": width, "height": height])
case "move":
  requireAccessibility()
  post(mouse(.mouseMoved, point(0)))
  emit(["ok": true])
case "click":
  requireAccessibility()
  click(point(0), arg(2), Int(arg(3)) ?? 1, flags(optional(4)))
  emit(["ok": true])
case "drag":
  requireAccessibility()
  drag(point(0), point(2), flags(optional(4)))
  emit(["ok": true])
case "scroll":
  requireAccessibility()
  post(mouse(.mouseMoved, point(0)))
  usleep(30_000)
  post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
               wheel1: Int32(number(arg(3))), wheel2: Int32(number(arg(2))), wheel3: 0))
  emit(["ok": true])
case "type":
  requireAccessibility()
  typeText(arg(0))
  emit(["ok": true])
case "key":
  requireAccessibility()
  guard let code = CGKeyCode(arg(0)) else { fail("key: bad key code") }
  pressKey(code, flags(optional(1)))
  emit(["ok": true])
case "overlay":
  guard let parent = pid_t(arg(0)) else { fail("overlay: bad pid") }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let delegate = Overlay(parent: parent, stopFile: arg(1), text: arg(2))
  app.delegate = delegate
  app.run()
default:
  fail("unknown command: \(command)")
}
