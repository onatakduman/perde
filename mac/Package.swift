// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Perde",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Perde", path: "Sources/Perde"),
        .testTarget(name: "PerdeTests", dependencies: ["Perde"], path: "Tests/PerdeTests"),
    ]
)
