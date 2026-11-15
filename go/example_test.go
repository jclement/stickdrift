// A runnable sketch of a game loop, shown in the package documentation.

package stickdrift_test

import (
	"context"
	"fmt"
	"time"

	stickdrift "github.com/jclement/stickdrift/go"
)

// Example opens a room, greets every phone and reads input once per frame.
func Example() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	host := stickdrift.NewHost(stickdrift.Options{
		Title: "My Game",
		Look:  stickdrift.Look{Layout: "dpad-ab", Theme: &stickdrift.Theme{Style: "retro"}},
	})
	host.Start(ctx)
	defer host.Close()
	<-host.Ready()
	fmt.Println("scan to join:", host.Info().JoinURL)

	frame := time.NewTicker(time.Second / 60)
	defer frame.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-frame.C:
		}
		host.Tick()
		for _, p := range host.Joined() {
			host.SetPad(p.Number(), stickdrift.Look{Label: fmt.Sprintf("PLAYER %d", p.Number()+1), Labels: map[stickdrift.Button]string{stickdrift.A: "JUMP"}})
			host.Haptic(p.Number(), 40)
		}
		for _, p := range host.Pads() {
			if p.JustPressed(stickdrift.A) {
				fmt.Printf("player %d jumps (p2p=%v)\n", p.Number()+1, p.P2P())
			}
			x, _ := p.Stick()
			_ = x // steer with it
		}
	}
}
