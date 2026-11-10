import ExpoModulesCore
import UIKit

// iOS suspends an app a few seconds after it leaves the screen, and a
// suspended app's Drona build stops mid-stream: the user only gets the result
// (and no notification) when they come back. A background task asks iOS for
// time to finish (about 30 s), which covers most builds. lib/backgroundTime.ts
// holds it while work runs and lets it go when the work ends.
public class BackgroundTimeModule: Module {
  private var taskId: UIBackgroundTaskIdentifier = .invalid

  public func definition() -> ModuleDefinition {
    Name("BackgroundTime")

    Function("begin") {
      DispatchQueue.main.async { self.beginTask() }
    }

    Function("end") {
      DispatchQueue.main.async { self.endTask() }
    }
  }

  private func beginTask() {
    guard taskId == .invalid else { return }
    // Out of time: iOS ends the task itself, or it would kill the app.
    taskId = UIApplication.shared.beginBackgroundTask(withName: "drona-build") { [weak self] in
      self?.endTask()
    }
  }

  private func endTask() {
    guard taskId != .invalid else { return }
    UIApplication.shared.endBackgroundTask(taskId)
    taskId = .invalid
  }
}
