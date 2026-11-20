//go:build !windows

package screenshot

import (
	"context"
	"fmt"
)

// CaptureAppScreenshot 仅 Windows 支持（主窗口截图）。
func (c *Capturer) CaptureAppScreenshot(ctx context.Context) (string, error) {
	return "", fmt.Errorf("当前平台不支持应用窗口截图")
}

// CaptureAppScreenshotRegion 仅 Windows 支持（主窗口区域截图）。
func (c *Capturer) CaptureAppScreenshotRegion(ctx context.Context, x, y, width, height int) (string, error) {
	return "", fmt.Errorf("当前平台不支持应用窗口截图")
}
