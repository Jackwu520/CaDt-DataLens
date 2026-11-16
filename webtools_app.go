package main

// webtools_app.go：联网工具的 Wails 绑定——内置引擎与外部工具都在 internal/webtools，这里只转发。

import "datalens/internal/webtools"

func (a *App) WebSearch(query string, maxResults int) (map[string]interface{}, error) {
	return webtools.Search(query, maxResults)
}

func (a *App) WebFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	return webtools.Fetch(rawURL, maxChars)
}

// WebFetchImage 抓取公网图片并转成 data URL（AI 的 read_image 看网图走这条通道）。
func (a *App) WebFetchImage(rawURL string) (map[string]interface{}, error) {
	return webtools.FetchImage(rawURL)
}

func (a *App) ExternalSearch(query string, maxResults int) (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := webtools.RequireProvider(cfg, "search"); err != nil {
		return nil, err
	}
	return webtools.ProviderSearch(cfg, query, maxResults)
}

func (a *App) ExternalFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := webtools.RequireProvider(cfg, "fetch"); err != nil {
		return nil, err
	}
	return webtools.ProviderFetch(cfg, rawURL, maxChars)
}

func (a *App) ExternalOCR(path, purpose string) (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := webtools.RequireProvider(cfg, "ocr"); err != nil {
		return nil, err
	}
	return webtools.ProviderOCR(cfg, path, purpose)
}

// ExternalTTS 语音合成落盘到 <workspace>/.cadt/gen/tts/，返回绝对路径与字节数。
func (a *App) ExternalTTS(workspace, text, voice string) (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := webtools.RequireProvider(cfg, "tts"); err != nil {
		return nil, err
	}
	return webtools.ProviderTTS(cfg, workspace, text, voice)
}

// ExternalASR 语音识别。wavBase64 非空时用转码后的音频，否则直接读 path（wav/opus）。
func (a *App) ExternalASR(name, path, wavBase64 string) (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := webtools.RequireProvider(cfg, "asr"); err != nil {
		return nil, err
	}
	audio, err := webtools.AudioBytesForASR(path, wavBase64)
	if err != nil {
		return nil, err
	}
	return webtools.ProviderASR(cfg, name, audio)
}

// ReadAudioDataURL 读取本地音频 data URL（前端 WebAudio 转码的输入）。
func (a *App) ReadAudioDataURL(path string) (string, error) {
	return webtools.ReadAudioDataURL(path)
}
