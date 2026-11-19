// GeoJSON 地图预览（示例插件，零第三方依赖）
//
// 演示两个扩展点：
//   1. cadt.registerViewer —— 把 .geojson 当成一个「地图」视图画在 canvas 上（等距圆柱投影）；
//   2. cadt.registerImporter —— 把内置解析不了的 .bin 转成十六进制取样文本，走只读虚拟文档打开。
//
// 关键约束（插件作者必读）：视图只负责渲染，**改数据一律经 ctx.requestSave 上抛**，
// 由宿主走既有脏标记与只读判定；切换视图 / 关标签时宿主会调 destroy()，定时器、全局监听
// 必须在那里断干净。
(() => {
    const VIEW_ID = 'geo-map';
    const MAX_FEATURES_DRAWN = 20000;

    const THEMES = {
        dark: {bg: '#1e1f24', grid: '#2c2f36', text: '#d7dae0', muted: '#8b909a', accent: '#4f8cff', fill: 'rgba(79, 140, 255, 0.18)'},
        light: {bg: '#ffffff', grid: '#e6e8ec', text: '#1f2328', muted: '#6b7280', accent: '#2f6fed', fill: 'rgba(47, 111, 237, 0.16)'},
    };

    function themeOf(name) {
        return THEMES[name] || THEMES.dark;
    }

    // ---- GeoJSON 解析：只取坐标，不关心属性 ----

    function collectPaths(geojson) {
        const paths = [];
        const push = (type, coords) => {
            if (!Array.isArray(coords) || !coords.length) return;
            paths.push({type, points: coords});
            if (paths.length > MAX_FEATURES_DRAWN) throw new Error('要素过多（超过 ' + MAX_FEATURES_DRAWN + ' 个几何），已停止解析');
        };
        const walkGeometry = (g) => {
            if (!g || !g.type) return;
            const c = g.coordinates;
            switch (g.type) {
                case 'Point': push('point', [c]); break;
                case 'MultiPoint': for (const p of c || []) push('point', [p]); break;
                case 'LineString': push('line', c || []); break;
                case 'MultiLineString': for (const line of c || []) push('line', line || []); break;
                case 'Polygon': for (const ring of c || []) push('poly', ring || []); break;
                case 'MultiPolygon': {
                    for (const poly of c || []) {
                        for (const ring of poly || []) push('poly', ring || []);
                    }
                    break;
                }
                case 'GeometryCollection': for (const sub of g.geometries || []) walkGeometry(sub); break;
                default: break;
            }
        };
        const walkFeature = (f) => {
            if (f && f.geometry) walkGeometry(f.geometry);
        };
        if (!geojson || typeof geojson !== 'object') return paths;
        if (geojson.type === 'FeatureCollection') {
            for (const f of geojson.features || []) walkFeature(f);
        } else if (geojson.type === 'Feature') {
            walkFeature(geojson);
        } else {
            walkGeometry(geojson);
        }
        return paths;
    }

    function boundsOf(paths) {
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        let valid = 0;
        for (const path of paths) {
            for (const point of path.points) {
                const lon = point && Number(point[0]);
                const lat = point && Number(point[1]);
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
                valid += 1;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            }
        }
        return valid ? {minLon, minLat, maxLon, maxLat, count: valid} : null;
    }

    // ---- 视图：canvas 渲染 ----

    function mount(container, ctx) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;';
        const bar = document.createElement('div');
        bar.style.cssText = 'flex:0 0 auto;padding:6px 10px;font-size:12px;font-family:inherit;';
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'flex:1 1 auto;display:block;width:100%;height:100%;';
        wrap.append(bar, canvas);
        container.textContent = '';
        container.appendChild(wrap);

        let theme = themeOf(ctx.getTheme());
        let paths = [];
        let bounds = null;
        let frame = 0;
        let disposed = false;

        bar.style.color = theme.muted;
        bar.textContent = '正在解析 GeoJSON…';
        canvas.style.background = theme.bg;

        function draw() {
            if (disposed) return;
            const dpr = window.devicePixelRatio || 1;
            const width = Math.max(1, canvas.clientWidth);
            const height = Math.max(1, canvas.clientHeight);
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            const g = canvas.getContext('2d');
            if (!g) return;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, width, height);
            g.fillStyle = theme.bg;
            g.fillRect(0, 0, width, height);

            if (!bounds) {
                g.fillStyle = theme.muted;
                g.font = '13px system-ui, sans-serif';
                g.fillText('没有可绘制的坐标', 16, 32);
                return;
            }

            // 等距圆柱投影：经纬度线性映射到画布，留 24px 边距，纬度轴翻转
            const pad = 24;
            const spanLon = Math.max(1e-6, bounds.maxLon - bounds.minLon);
            const spanLat = Math.max(1e-6, bounds.maxLat - bounds.minLat);
            const scale = Math.min((width - pad * 2) / spanLon, (height - pad * 2) / spanLat);
            const offsetX = (width - spanLon * scale) / 2;
            const offsetY = (height - spanLat * scale) / 2;
            const project = (point) => {
                const lon = Number(point[0]);
                const lat = Number(point[1]);
                return [
                    offsetX + (lon - bounds.minLon) * scale,
                    offsetY + (bounds.maxLat - lat) * scale,
                ];
            };

            // 网格（每 1/4 屏画一条）：让「地图」在没有底图时也能看出比例
            g.strokeStyle = theme.grid;
            g.lineWidth = 1;
            g.beginPath();
            for (let i = 1; i < 4; i += 1) {
                const x = (width / 4) * i;
                const y = (height / 4) * i;
                g.moveTo(x, 0);
                g.lineTo(x, height);
                g.moveTo(0, y);
                g.lineTo(width, y);
            }
            g.stroke();

            g.strokeStyle = theme.accent;
            g.fillStyle = theme.fill;
            g.lineWidth = 1.4;
            for (const path of paths) {
                if (path.type === 'point') {
                    g.fillStyle = theme.accent;
                    for (const point of path.points) {
                        const [x, y] = project(point);
                        g.beginPath();
                        g.arc(x, y, 2.4, 0, Math.PI * 2);
                        g.fill();
                    }
                    g.fillStyle = theme.fill;
                    continue;
                }
                g.beginPath();
                let started = false;
                for (const point of path.points) {
                    const [x, y] = project(point);
                    if (!started) {
                        g.moveTo(x, y);
                        started = true;
                    } else {
                        g.lineTo(x, y);
                    }
                }
                if (!started) continue;
                if (path.type === 'poly') {
                    g.closePath();
                    g.fill();
                }
                g.stroke();
            }
        }

        function scheduleDraw() {
            if (disposed || frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                draw();
            });
        }

        function describe() {
            if (!bounds) {
                bar.textContent = '没有可绘制的坐标（不是有效的 GeoJSON 几何）';
                return;
            }
            const fixed = (n) => n.toFixed(3);
            bar.textContent = '几何 ' + paths.length + ' 个 · 坐标点 ' + bounds.count +
                ' · 经纬范围 ' + fixed(bounds.minLon) + ',' + fixed(bounds.minLat) +
                ' → ' + fixed(bounds.maxLon) + ',' + fixed(bounds.maxLat);
        }

        function load(text) {
            try {
                paths = collectPaths(JSON.parse(String(text || '')));
                bounds = boundsOf(paths);
            } catch (e) {
                paths = [];
                bounds = null;
                bar.textContent = 'GeoJSON 解析失败：' + ((e && e.message) || e);
                bar.style.color = theme.muted;
                draw();
                return;
            }
            describe();
            draw();
        }

        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => scheduleDraw())
            : null;
        if (observer) observer.observe(canvas);
        const onWindowResize = () => scheduleDraw();
        window.addEventListener('resize', onWindowResize);

        // 底层编辑器改动 → 视图重绘（宿主在 markDocDirty 时推新文本进来）
        const offChange = ctx.onChange((text) => load(text));

        load(ctx.getData());

        return {
            resize: scheduleDraw,
            setTheme(name) {
                theme = themeOf(name);
                bar.style.color = theme.muted;
                canvas.style.background = theme.bg;
                draw();
            },
            destroy() {
                disposed = true;
                if (frame) cancelAnimationFrame(frame);
                frame = 0;
                window.removeEventListener('resize', onWindowResize);
                if (observer) observer.disconnect();
                if (typeof offChange === 'function') offChange();
                wrap.remove();
            },
        };
    }

    // ---- 导入器：二进制取样 ----

    function base64ToBytes(b64) {
        const binary = atob(String(b64 || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    cadt.registerImporter({
        id: 'bin-peek',
        label: '二进制取样',
        extensions: ['bin'],
        async convert(ctx) {
            const bytes = base64ToBytes(await ctx.readBinaryFile(ctx.path));
            const rows = [];
            const limit = Math.min(bytes.length, 256);
            for (let off = 0; off < limit; off += 16) {
                const slice = bytes.subarray(off, Math.min(off + 16, limit));
                const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
                rows.push('| ' + off.toString(16).padStart(6, '0') + ' | `' + hex + '` | `' + ascii + '` |');
            }
            const text = [
                '# 二进制取样：' + ctx.name,
                '',
                '- 大小：' + bytes.length + ' 字节',
                '- 取样：前 ' + limit + ' 字节（每行 16 字节）',
                '',
                '| 偏移 | 十六进制 | ASCII |',
                '| --- | --- | --- |',
                ...rows,
                '',
            ].join('\n');
            return {text, name: String(ctx.name || 'sample').replace(/\.[^.]+$/, '') + '.bin.md'};
        },
    });

    cadt.registerViewer({
        id: VIEW_ID,
        label: '地图',
        formats: ['geojson'],   // 也接受扩展名（不带点）：.geojson 多半落在内置 text 格式上
        priority: 10,
        mount,
    });
})();
