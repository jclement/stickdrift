// A runnable sketch of a game loop, shown in the package documentation.

package controller_test

import (
	"context"
	"fmt"
	"time"

	controller "github.com/jclement/controller/go"
)

// Example opens a room, greets every phone and reads input once per frame.
func Example() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	host := controller.NewHost(controller.Options{
		Title: "My Game",
		Look:  controller.Look{Layout: "dpad-ab", Theme: &controller.Theme{Style: "retro"}},
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
			host.SetPad(p.Number(), controller.Look{Label: fmt.Sprintf("PLAYER %d", p.Number()+1), Labels: map[controller.Button]string{controller.A: "JUMP"}})
			host.Haptic(p.Number(), 40)
		}
		for _, p := range host.Pads() {
			if p.JustPressed(controller.A) {
				fmt.Printf("player %d jumps (p2p=%v)\n", p.Number()+1, p.P2P())
			}
			x, _ := p.Stick()
			_ = x // steer with it
		}
	}
}
