//go:build !js

// Native specifics: pion must resolve the mDNS ".local" names browsers use
// for LAN addresses itself (QueryOnly: we don't advertise our own), and the
// relay WebSocket can carry a User-Agent.
package stickdrift

import (
	"net/http"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

func settingEngine() webrtc.SettingEngine {
	var se webrtc.SettingEngine
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	return se
}

func dialOptions(userAgent string) *websocket.DialOptions {
	return &websocket.DialOptions{HTTPHeader: http.Header{"User-Agent": {userAgent}}}
}
