// Command screen is a tiny host for the "screen" layout: phones get a lobby
// with a READY button, then a private hand of cards, then a vote, a bet, a
// typed answer and a slider, and finally a locked "judge is thinking" page.
// Every event that reaches the game is printed, one per line, so a script
// (or a person) can watch answers arrive and stale ones not.
//
//	STICKDRIFT_URL=http://localhost:8787 go run ./examples/screen
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	stickdrift "github.com/jclement/stickdrift/go"
)

func main() {
	code := flag.String("code", "", "room code to claim (default random)")
	flag.Parse()

	lobby := &stickdrift.Screen{ID: "lobby", Items: []stickdrift.Element{
		{Type: stickdrift.ElemHeading, Text: "SCREEN DEMO"},
		{Type: stickdrift.ElemText, Text: "Tap READY when you are."},
		{Type: stickdrift.ElemButton, ID: "ready", Label: "READY"},
	}}
	host := stickdrift.NewHost(stickdrift.Options{
		Title: "Screen demo",
		Code:  *code,
		Look:  stickdrift.Look{Layout: "screen", Screen: lobby},
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	host.Start(ctx)
	defer host.Close()
	select {
	case <-host.Ready():
	case <-ctx.Done():
		return
	}
	fmt.Println("JOIN", host.Info().JoinURL)

	tick := time.NewTicker(time.Second / 30)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		host.Tick()
		for _, p := range host.Joined() {
			fmt.Println("JOINED", p.Number())
		}
		for _, ev := range host.Events() {
			b, _ := json.Marshal(map[string]any{"pad": ev.Pad.Number(), "screen": ev.Screen, "element": ev.Element, "type": ev.Type, "picks": ev.Picks, "number": ev.Number, "text": ev.Text})
			fmt.Println("EVENT", string(b))
			n := ev.Pad.Number()
			switch ev.Element {
			case "ready":
				host.SetPad(n, stickdrift.Look{Screen: hand()})
			case "hand":
				host.SetPad(n, stickdrift.Look{Screen: vote(n, false)})
			case "done":
				host.SetPad(n, stickdrift.Look{Screen: vote(n, true)})
			}
		}
	}
}

// hand is a private hand: pick two cards, in order.
func hand() *stickdrift.Screen {
	return &stickdrift.Screen{ID: "round1", Items: []stickdrift.Element{
		{Type: stickdrift.ElemText, Text: "Round 1"},
		{Type: stickdrift.ElemHeading, Text: "My superpower is ____, but only during ____."},
		{Type: stickdrift.ElemCards, ID: "hand", Pick: 2, Submit: "PLAY THEM", Cards: []stickdrift.Card{
			{ID: "c1", Text: "Aggressive napping"},
			{ID: "c2", Text: "Tax season"},
			{ID: "c3", Text: "A modest amount of soup"},
			{ID: "c4", Text: "Mondays"},
			{ID: "c5", Text: "Unsolicited jazz"},
		}},
		{Type: stickdrift.ElemStatus, Text: "Waiting for the others…", Seconds: 60},
	}}
}

// vote is everything else at once: a vote, a bet, a typed answer, a slider
// and a DONE button; locked once DONE is pressed.
func vote(n int, locked bool) *stickdrift.Screen {
	s := &stickdrift.Screen{ID: "round2", Locked: locked, Items: []stickdrift.Element{
		{Type: stickdrift.ElemHeading, Text: "Who played the worst card?"},
		{Type: stickdrift.ElemChoices, ID: "vote", Options: []stickdrift.Option{
			{ID: "me", Text: "Me, obviously", Pad: stickdrift.Seat(n)},
			{ID: "ann", Text: "Ann", Color: "#3a86ff"},
			{ID: "bo", Text: "Bo", Color: "#ffbe0b"},
		}},
		{Type: stickdrift.ElemStepper, ID: "bet", Min: 0, Max: 100, Step: 10, Value: 20, Submit: "BET"},
		{Type: stickdrift.ElemInput, ID: "answer", MaxLength: 40, Placeholder: "A better answer"},
		{Type: stickdrift.ElemSlider, ID: "spice", Min: 0, Max: 10, Step: 1, Value: 5},
		{Type: stickdrift.ElemButton, ID: "done", Label: "DONE", Color: "#38d996"},
	}}
	if locked {
		s.Items = append(s.Items, stickdrift.Element{Type: stickdrift.ElemStatus, Text: "Locked in. Judge is thinking…", Progress: 0.6})
	}
	return s
}
