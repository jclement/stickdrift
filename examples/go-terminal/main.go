// go-terminal opens a Controller room from a terminal, prints its QR code,
// and logs every phone's input as it happens. It is the smallest complete
// host: copy it as the starting point for a Go game.
//
//	go run . [-origin http://localhost:8787] [-layout gamepad] [-relay-only]
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	controller "github.com/jclement/controller/go"
)

// colours tint each player's phone so people can tell who is who.
var colours = []string{"#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b", "#b388ff", "#ff8c1a"}

func main() {
	origin := flag.String("origin", "", "relay URL (default $CONTROLLER_URL or "+controller.DefaultOrigin+")")
	layout := flag.String("layout", "gamepad", "phone layout: "+strings.Join(controller.Layouts, ", "))
	relayOnly := flag.Bool("relay-only", false, "no WebRTC: all input through the relay")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	host := controller.NewHost(controller.Options{
		Origin:     *origin,
		Title:      "Terminal",
		Look:       controller.Look{Layout: *layout, Swap: controller.Bool(true)},
		DisableP2P: *relayOnly,
	})
	host.Start(ctx)
	defer host.Close()

	fmt.Println("Opening a room…")
	select {
	case <-host.Ready():
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
		fmt.Fprintf(os.Stderr, "could not open a room: %v\n", host.Info().Err)
		os.Exit(1)
	}
	info := host.Info()
	if code, err := renderQR(info.JoinURL); err == nil {
		fmt.Print(code)
	}
	fmt.Printf("\nRoom %s · scan the code or open %s\nCtrl-C to quit.\n\n", info.Code, info.JoinURL)
	loop(ctx, host)
}

// loop is the "game": 60 ticks a second, log joins, leaves and changes.
func loop(ctx context.Context, host *controller.Host) {
	frame := time.NewTicker(time.Second / 60)
	defer frame.Stop()
	last := map[int]string{}
	for {
		select {
		case <-ctx.Done():
			fmt.Println("\nbye")
			return
		case <-frame.C:
		}
		host.Tick()
		for _, p := range host.Joined() {
			n := p.Number()
			host.SetPad(n, controller.Look{Label: fmt.Sprintf("PLAYER %d", n+1), Color: colours[n%len(colours)]})
			host.Haptic(n, 40)
			logf(p, "joined")
		}
		for _, p := range host.Left() {
			logf(p, "left")
			delete(last, p.Number())
		}
		for _, p := range host.Pads() {
			if line := describe(p); line != last[p.Number()] {
				last[p.Number()] = line
				logf(p, "%s", line)
			}
		}
	}
}

// logf prints one line about a pad, with the path its input takes.
func logf(p *controller.Pad, format string, args ...any) {
	path := "relay"
	if p.P2P() {
		path = "P2P"
	}
	if rtt := p.RTT(); rtt > 0 {
		path = fmt.Sprintf("%s %d ms", path, rtt)
	}
	fmt.Printf("%s  player %d  [%s]  %s\n", time.Now().Format("15:04:05.000"), p.Number()+1, path, fmt.Sprintf(format, args...))
}

// describe summarises what a pad is doing: presses this tick, holds, sticks.
func describe(p *controller.Pad) string {
	var parts []string
	for _, b := range controller.Buttons {
		switch {
		case p.JustPressed(b):
			parts = append(parts, b.String()+"↓")
		case p.Held(b):
			parts = append(parts, b.String())
		case p.JustReleased(b):
			parts = append(parts, b.String()+"↑")
		}
	}
	if x, y := p.Stick(); x != 0 || y != 0 {
		parts = append(parts, fmt.Sprintf("L(%+.2f,%+.2f)", x, y))
	}
	if x, y := p.RightStick(); x != 0 || y != 0 {
		parts = append(parts, fmt.Sprintf("R(%+.2f,%+.2f)", x, y))
	}
	if len(parts) == 0 {
		return "idle"
	}
	return strings.Join(parts, " ")
}
