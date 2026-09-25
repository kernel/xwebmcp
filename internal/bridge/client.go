package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// ErrNotRunning means no native host is listening: Chrome is closed, the
// extension is not loaded, or the host manifest is not installed.
var ErrNotRunning = errors.New("the xwebmcp extension is not connected; open Chrome with the extension loaded, or run `xwebmcp setup chrome`")

// Client talks to a running Host over its Unix socket.
type Client struct {
	conn    net.Conn
	reader  *bufio.Reader
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan Response
	nextID  atomic.Int64
	closed  chan struct{}
}

// Dial connects to the host socket in stateDir.
func Dial(ctx context.Context, stateDir string) (*Client, error) {
	socket := SocketPath(stateDir)
	if _, err := os.Stat(socket); err != nil {
		return nil, ErrNotRunning
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, ErrNotRunning
	}
	client := &Client{conn: conn, reader: bufio.NewReaderSize(conn, 1<<20), pending: map[int64]chan Response{}, closed: make(chan struct{})}
	go client.readLoop()
	return client, nil
}

func (c *Client) readLoop() {
	defer close(c.closed)
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.pending {
				ch <- Response{ID: id, Error: &Error{Message: "bridge connection closed"}}
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		var response Response
		if json.Unmarshal(line, &response) != nil {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[response.ID]
		delete(c.pending, response.ID)
		c.mu.Unlock()
		if ok {
			ch <- response
		}
	}
}

// Close releases the connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// Call invokes an extension API method and decodes its result into out.
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	var raw json.RawMessage
	if params != nil {
		data, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = data
	}
	id := c.nextID.Add(1)
	payload, err := json.Marshal(Request{ID: id, Method: method, Params: raw})
	if err != nil {
		return err
	}
	ch := make(chan Response, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	c.writeMu.Lock()
	_, err = c.conn.Write(append(payload, '\n'))
	c.writeMu.Unlock()
	if err != nil {
		return fmt.Errorf("write to bridge: %w", err)
	}
	select {
	case response := <-ch:
		if response.Error != nil {
			return response.Error
		}
		if out != nil && len(response.Result) > 0 {
			return json.Unmarshal(response.Result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// Ping checks that the extension answers.
func (c *Client) Ping(ctx context.Context) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var info map[string]any
	if err := c.Call(ctx, "ping", nil, &info); err != nil {
		return nil, err
	}
	return info, nil
}
