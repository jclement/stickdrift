// Package stickdrift turns phones into game controllers through the
// StickDrift relay (https://stickdrift.net). Your program is the
// host: it opens a room, shows the join URL as a QR code, and every phone
// that opens it becomes a Pad.
//
//	host := stickdrift.NewHost(stickdrift.Options{Title: "My Game", Look: stickdrift.Look{Layout: "dpad-ab"}})
//	host.Start(ctx)
//	defer host.Close()
//	<-host.Ready()
//	fmt.Println("join at", host.Info().JoinURL)
//
//	for range time.Tick(time.Second / 60) { // your game loop
//		host.Tick()
//		for _, p := range host.Joined() {
//			host.SetPad(p.Number(), stickdrift.Look{Label: fmt.Sprintf("PLAYER %d", p.Number()+1)})
//		}
//		for _, p := range host.Pads() {
//			if p.JustPressed(stickdrift.A) {
//				jump(p.Number())
//			}
//		}
//	}
//
// Input arrives over a direct WebRTC data channel when the phone can reach
// you (about 1 ms on the same Wi-Fi) and over the relay WebSocket otherwise;
// the API is the same either way. The network runs on background goroutines
// and every method is safe to call from any goroutine. Pad state changes
// only at Tick, so reads within one frame agree with each other.
//
// The wire protocol is PROTOCOL.md in the repository.
package stickdrift
