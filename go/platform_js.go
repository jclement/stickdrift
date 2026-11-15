//go:build js

// Browser (WebAssembly) specifics: pion wraps the browser's RTCPeerConnection,
// which resolves mDNS itself, and browser WebSockets can't set headers. This
// is what lets a Go game compiled to wasm host StickDrift in a web page.
package stickdrift

import (
	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

func settingEngine() webrtc.SettingEngine { return webrtc.SettingEngine{} }

func dialOptions(string) *websocket.DialOptions { return nil }
