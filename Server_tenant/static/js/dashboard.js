// ================= 1. CẤU HÌNH MAPVINA & KHỞI TẠO BẢN ĐỒ GIS =================
const MAPVINA_KEY = "ef0b8a098ea3f69effb317920289873a2e";
const MAPVINA_CHECK_URL = `https://account.mapvina.com/api/v1/000318/check?key=${MAPVINA_KEY}`;

async function verifyMapVinaKey() {
    const badge = document.getElementById('mapvina-status');
    try {
        const response = await fetch(MAPVINA_CHECK_URL);
        if (response.ok) {
            if (badge) badge.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i> MapVina Connected';
        } else {
            if (badge) badge.innerHTML = '<i class="fa-solid fa-circle-info text-amber-400"></i> MapVina Key Active';
        }
    } catch (err) {
        if (badge) badge.innerHTML = '<i class="fa-solid fa-map text-blue-400"></i> MapVina GIS Ready';
    }
}

const VIETNAM_BOUNDS = [
    [-5.0, 95.0],   // Tây Nam (phía nam Trường Sa)
    [28.0, 125.0]   // Đông Bắc (vịnh Bắc Bộ, Hoàng Sa, biển Đông)
];
const DEFAULT_MAP_CENTER = [16.054407, 108.202167];
const DEFAULT_MAP_ZOOM = 7;

const mapvinaStreetLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '© MapVina GIS | HC TECH',
    maxZoom: 20,
    noWrap: true
});

const mapvinaSatelliteLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&hl=vi&x={x}&y={y}&z={z}', {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '© MapVina Satellite',
    maxZoom: 20,
    noWrap: true
});

const seaMapLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    attribution: '© OpenSeaMap (Hải đồ Cứu hộ Biển)',
    noWrap: true
});

// Cấu hình bản đồ: Chặn zoom quá xa (minZoom: 5) & giới hạn không gian tránh lặp lại thế giới
const map = L.map('gis-map', {
    center: DEFAULT_MAP_CENTER,
    zoom: DEFAULT_MAP_ZOOM,
    minZoom: 5,
    maxZoom: 19,
    maxBounds: VIETNAM_BOUNDS,
    maxBoundsViscosity: 0.9,
    layers: [mapvinaStreetLayer],
    closePopupOnClick: true,
    worldCopyJump: false,
    attributionControl: false
});
window.map = map;

map.on('click', function () {
    map.closePopup();
});

L.control.layers({
    "Bản đồ Hành chính (MapVina)": mapvinaStreetLayer,
    "Bản đồ Vệ tinh (MapVina Satellite)": mapvinaSatelliteLayer
}).addTo(map);

setTimeout(() => {
    map.invalidateSize();
}, 300);

window.addEventListener('resize', () => {
    if (typeof map !== 'undefined' && map) {
        map.invalidateSize();
    }
});

let markersLayer = L.layerGroup().addTo(map);
let routeLayer = L.layerGroup().addTo(map);
let currentAlertId = null;
let currentEmergencyDeviceId = null;
let currentEmergencyCoords = null;

// Lưu danh sách Marker theo ID để KHÔNG xóa/tạo lại làm mất Popup đang mở
let deviceMarkersMap = {};
window.deviceMarkersMap = deviceMarkersMap;

// Đóng / Mở Sidebar và tự động co giãn lại bản đồ
function toggleSidebar() {
    if (window.innerWidth <= 768 && typeof toggleMobileSidebar === 'function') {
        toggleMobileSidebar();
        return;
    }
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('sidebar-collapsed');
    sidebar.classList.toggle('is-closed');
    setTimeout(() => {
        if (typeof map !== 'undefined' && map) {
            map.invalidateSize();
        }
    }, 300);
}

// Thu gọn / Mở rộng hộp Bộ lọc nổi ở góc dưới phải bản đồ
function toggleFilterBody() {
    const body = document.getElementById('floating-filter-body');
    const icon = document.getElementById('floating-filter-icon');
    if (!body) return;
    body.classList.toggle('hidden');
    if (icon) {
        icon.className = body.classList.contains('hidden')
            ? 'fa-solid fa-chevron-up text-xs'
            : 'fa-solid fa-chevron-down text-xs';
    }
}

// ================= 2. HỆ THỐNG CÒI BÁO ĐỘNG WEB AUDIO API =================
let soundEnabled = true;
let sirenInterval = null;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSirenBeep() {
    if (!soundEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(650, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(980, audioCtx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
}

function startSiren() {
    if (!soundEnabled) return;
    try {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => { });
        }
        playSirenBeep();
    } catch (e) {
        console.warn("AudioContext resume:", e);
    }
    if (!sirenInterval) {
        sirenInterval = setInterval(playSirenBeep, 500);
    }
}

function stopSiren() {
    if (sirenInterval) {
        clearInterval(sirenInterval);
        sirenInterval = null;
    }
}

function toggleSoundSetting() {
    soundEnabled = !soundEnabled;
    const soundText = soundEnabled ? "Âm báo: BẬT" : "Âm báo: TẮT";
    const soundClass = soundEnabled
        ? "fa-solid fa-volume-high text-emerald-500"
        : "fa-solid fa-volume-xmark text-slate-400";
    const t1 = document.getElementById('text-sound');
    if (t1) t1.innerText = soundText;
    const i1 = document.getElementById('icon-sound');
    if (i1) i1.className = soundClass;

    const btnSound = document.getElementById('btn-sound-toggle');
    if (btnSound) {
        btnSound.title = soundEnabled ? "Âm báo: Đang BẬT (Bấm để tắt)" : "Âm báo: Đang TẮT (Bấm để bật)";
    }

    const t2 = document.getElementById('mobile-text-sound');
    if (t2) t2.innerText = soundEnabled ? "Âm: BẬT" : "Âm: TẮT";
    const i2 = document.getElementById('mobile-icon-sound');
    if (i2) i2.className = soundEnabled ? "fa-solid fa-volume-high text-emerald-500" : "fa-solid fa-volume-xmark text-slate-400";

    if (!soundEnabled) stopSiren();
}

// ================= 3. RENDER MARKER THIẾT BỊ & TỰ ĐỘNG CĂN CHỈNH ZOOM =================
let hasInitialMapFit = false;

// Thuật toán phát hiện và gom nhóm cụm thiết bị chính, loại bỏ các điểm ngoại lai cá biệt (như thiết bị test cách 500-600km)
function getClusteredCoords(coords) {
    if (!coords || coords.length <= 2) return coords;

    const lats = coords.map(c => c[0]).sort((a, b) => a - b);
    const lngs = coords.map(c => c[1]).sort((a, b) => a - b);
    const mid = Math.floor(coords.length / 2);
    const medLat = coords.length % 2 !== 0 ? lats[mid] : (lats[mid - 1] + lats[mid]) / 2;
    const medLng = coords.length % 2 !== 0 ? lngs[mid] : (lngs[mid - 1] + lngs[mid]) / 2;

    const withDist = coords.map(c => {
        const dLat = (c[0] - medLat) * 111;
        const dLng = (c[1] - medLng) * 106;
        return { coord: c, dist: Math.sqrt(dLat * dLat + dLng * dLng) };
    });

    // Gom cụm chính trong phạm vi bán kính 50km tính từ trung vị
    const cluster = withDist.filter(d => d.dist <= 50);

    // Nếu trên 70% số thiết bị nằm trong cụm này, ưu tiên zoom vào cụm chính
    if (cluster.length >= Math.ceil(coords.length * 0.7) && cluster.length >= 2) {
        return cluster.map(d => d.coord);
    }
    return coords;
}

// Tự động căn chỉnh và zoom khung nhìn bản đồ bao quát toàn bộ vị trí các thiết bị với hiệu ứng mượt mà
function fitMapToDevices(animate = true, duration = 1.2, allowClusterFilter = true) {
    if (typeof map === 'undefined' || !map) return false;

    const coords = [];
    Object.values(deviceMarkersMap).forEach(item => {
        if (item && item.marker) {
            const latlng = item.marker.getLatLng();
            if (latlng && typeof latlng.lat === 'number' && typeof latlng.lng === 'number' && !isNaN(latlng.lat) && !isNaN(latlng.lng)) {
                coords.push([latlng.lat, latlng.lng]);
            }
        }
    });

    if (coords.length === 0) return false;

    // Đảm bảo kích thước container của bản đồ đã được tính toán chính xác
    map.invalidateSize();

    const targetCoords = allowClusterFilter ? getClusteredCoords(coords) : coords;
    const bounds = L.latLngBounds(targetCoords);
    if (!bounds.isValid()) return false;

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const isSinglePoint = targetCoords.length === 1 ||
        (Math.abs(sw.lat - ne.lat) < 0.0001 && Math.abs(sw.lng - ne.lng) < 0.0001);

    if (isSinglePoint) {
        if (animate && typeof map.flyTo === 'function') {
            map.flyTo(bounds.getCenter(), 14, { duration: duration });
        } else {
            map.setView(bounds.getCenter(), 14);
        }
        return true;
    }

    if (animate && typeof map.flyToBounds === 'function') {
        map.flyToBounds(bounds, {
            padding: [40, 40],
            maxZoom: 13,
            duration: duration
        });
    } else {
        map.fitBounds(bounds, {
            padding: [40, 40],
            maxZoom: 13,
            animate: false
        });
    }
    return true;
}
window.fitMapToDevices = fitMapToDevices;

function getDeviceVisual(d) {
    const rawType = (d.device_type_raw || '').toUpperCase();
    const typeDisplay = (d.device_type || '').toLowerCase();
    const isGateway = rawType === 'GATEWAY' || typeDisplay.includes('gateway');
    const isCamera = rawType === 'CAMERA' || typeDisplay.includes('camera');
    const isShip = !isGateway && !isCamera && Boolean(d.has_gps);

    if (isGateway) {
        return {
            categoryKey: 'gateway',
            typeName: 'Trạm Gateway LoRaWAN',
            iconClass: 'fa-tower-broadcast',
            shapeClass: 'pin-gateway',
            prefixIcon: '📡'
        };
    }
    if (isShip) {
        return {
            categoryKey: 'ship',
            typeName: 'Thiết bị GPS',
            iconClass: 'fa-location-dot',
            shapeClass: 'pin-ship',
            prefixIcon: '📍'
        };
    }
    if (isCamera) {
        return {
            categoryKey: 'camera',
            typeName: 'Camera giám sát',
            iconClass: 'fa-video',
            shapeClass: 'pin-camera',
            prefixIcon: '📹'
        };
    }
    // Thiết bị trên Đất liền (Nút nhấn cố định / Nhà ở / Cơ sở)
    let icon = 'fa-building';
    let typeName = 'Nút nhấn Đất liền';
    let prefixIcon = '🏢';
    let catClass = 'pin-cat-default';

    if (d.category_type === 'CHAY') {
        icon = 'fa-fire';
        typeName = 'Báo Cháy (Đất liền)';
        prefixIcon = '🔥';
        catClass = 'pin-cat-chay';
    } else if (d.category_type === 'AN_NINH') {
        icon = 'fa-shield-halved';
        typeName = 'An Ninh (Đất liền)';
        prefixIcon = '🛡️';
        catClass = 'pin-cat-anninh';
    } else if (d.category_type === 'CAP_CUU_Y_TE') {
        icon = 'fa-heart-pulse';
        typeName = 'Cấp Cứu Y Tế (Đất liền)';
        prefixIcon = '🏥';
        catClass = 'pin-cat-yte';
    }
    return {
        categoryKey: 'button',
        typeName: typeName,
        iconClass: icon,
        shapeClass: `pin-button ${catClass}`,
        prefixIcon: prefixIcon
    };
}

async function refreshMapMarkers(forceFit = false) {
    const gpsFilter = document.getElementById('filter-gps')?.value || '';
    const typeFilter = document.getElementById('filter-type')?.value || '';
    const statusFilter = document.getElementById('filter-status')?.value || '';
    const res = await fetch(`/api/state/?has_gps=${gpsFilter}&status=${statusFilter}&device_type=${typeFilter}`);
    const data = await res.json();

    const activeIds = new Set();

    data.devices.forEach(d => {
        activeIds.add(d.id);

        if (d.latitude == null || d.longitude == null || isNaN(parseFloat(d.latitude)) || isNaN(parseFloat(d.longitude))) {
            return;
        }

        let statusClass = 'marker-normal';
        if (d.connection_status === 'SOS') statusClass = 'marker-sos';
        else if (d.connection_status === 'PROCESSING') statusClass = 'marker-processing';
        else if (d.connection_status === 'OFFLINE') statusClass = 'marker-offline';

        const visual = getDeviceVisual(d);
        const iconHtml = `<div class="custom-pin ${visual.shapeClass} ${statusClass}" title="${d.device_name} (${visual.typeName})">
            <i class="fa-solid ${visual.iconClass}"></i>
        </div>`;

        let alertBtnHtml = '';
        if (d.connection_status === 'SOS' || d.connection_status === 'PROCESSING') {
            alertBtnHtml = `
                <div class="pt-2 border-t mt-2" style="border-color: #e2e8f0;">
                    <button
                        type="button"
                        onclick="event.stopPropagation(); turnOffDeviceAlert(${d.id})"
                        class="w-full bg-red-600 hover:bg-red-700 active:scale-95 text-white font-bold py-1.5 px-3 rounded-lg text-xs flex items-center justify-center gap-1.5 shadow-md transition cursor-pointer"
                        title="Tắt cảnh báo và tắt còi báo động"
                    >
                        <i class="fa-solid fa-bell-slash"></i> Tắt cảnh báo & Tắt còi
                    </button>
                </div>
            `;
        }

        const popupHtml = `
            <div class="text-slate-900 text-xs space-y-1.5 min-w-[225px]">
                <div class="font-bold text-sm border-b pb-1 flex items-center justify-between">
                    <span>${visual.prefixIcon} ${d.device_name}</span>
                    ${(d.connection_status === 'SOS' || d.connection_status === 'PROCESSING') ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold animate-pulse">SOS</span>' : ''}
                </div>
                <div><strong>ID:</strong> <span class="font-mono text-slate-700">${d.dev_eui}</span></div>
                <div><strong>Phân loại:</strong> <span class="font-semibold text-cyan-700">${visual.typeName}</span></div>
                <div><strong>Chủ hộ/SĐT:</strong> ${d.customer_name} - ${d.emergency_phone}</div>
                <div><strong>Tọa độ/Vị trí:</strong> ${d.has_gps ? d.latitude + ', ' + d.longitude : d.address}</div>
                <div><strong>Dung lượng Pin:</strong> <span class="text-emerald-600 font-bold">${d.battery_level}%</span></div>
                <div><strong>Cập nhật cuối:</strong> ${d.last_seen}</div>
                ${alertBtnHtml}
            </div>
        `;

        if (deviceMarkersMap[d.id]) {
            // Nếu Marker đã tồn tại: Cập nhật vị trí, hình dáng, icon và nội dung
            const existing = deviceMarkersMap[d.id];
            existing.marker.setLatLng([d.latitude, d.longitude]);

            if (existing.status !== d.connection_status || existing.shapeClass !== visual.shapeClass || existing.iconClass !== visual.iconClass) {
                const newIcon = L.divIcon({ className: '', html: iconHtml, iconSize: [36, 36], iconAnchor: [18, 18] });
                existing.marker.setIcon(newIcon);
                existing.status = d.connection_status;
                existing.shapeClass = visual.shapeClass;
                existing.iconClass = visual.iconClass;
            }
            existing.marker.getPopup().setContent(popupHtml);
            if (typeof existing.marker.setTooltipContent === 'function') {
                existing.marker.setTooltipContent(`${visual.prefixIcon} ${d.device_name} (${visual.typeName})`);
            }
        } else {
            // Tạo mới Marker với thuộc tính giữ cố định Popup khi click và Tooltip khi hover
            const customIcon = L.divIcon({ className: '', html: iconHtml, iconSize: [36, 36], iconAnchor: [18, 18] });
            const marker = L.marker([d.latitude, d.longitude], { icon: customIcon }).addTo(markersLayer);

            marker.bindPopup(popupHtml, {
                autoClose: true,
                closeOnClick: true
            });

            marker.bindTooltip(`${visual.prefixIcon} ${d.device_name} (${visual.typeName})`, {
                className: 'hc-map-tooltip',
                direction: 'top',
                offset: [0, -18]
            });

            marker.on('click', function (e) {
                if (typeof L !== 'undefined' && L.DomEvent) {
                    L.DomEvent.stopPropagation(e);
                }
                map.closePopup();
                this.openPopup();
            });

            deviceMarkersMap[d.id] = {
                marker: marker,
                status: d.connection_status,
                shapeClass: visual.shapeClass,
                iconClass: visual.iconClass
            };
        }
    });

    // Xóa các Marker không còn nằm trong bộ lọc hiện tại
    Object.keys(deviceMarkersMap).forEach(id => {
        const numId = parseInt(id);
        if (!activeIds.has(numId)) {
            markersLayer.removeLayer(deviceMarkersMap[id].marker);
            delete deviceMarkersMap[id];
        }
    });

    // Tự động căn chỉnh và zoom lại vị trí của các thiết bị khi tải trang lần đầu hoặc khi đổi bộ lọc
    if (!data.emergency) {
        if (!hasInitialMapFit) {
            map.invalidateSize();
            if (fitMapToDevices(true, 1.2)) {
                hasInitialMapFit = true;
            }
        } else if (forceFit === true) {
            map.invalidateSize();
            fitMapToDevices(true, 1.2);
        }
    }

    // Kiểm tra trạng thái cảnh báo khẩn cấp và cập nhật nút bấm trên Header
    const activeSosDev = data.devices ? data.devices.find(dev => dev.connection_status === 'SOS' || dev.connection_status === 'PROCESSING') : null;
    const sosCount = data.devices ? data.devices.filter(dev => dev.connection_status === 'SOS' || dev.connection_status === 'PROCESSING').length : 0;
    const sosEl = document.getElementById('stat-sos');
    if (sosEl) sosEl.innerText = sosCount;

    if (data.emergency) {
        currentEmergencyDeviceId = data.emergency.device_id;
        currentEmergencyCoords = [data.emergency.latitude, data.emergency.longitude];
        setEmergencyButtonState(true, data.emergency.device_id);
    } else if (activeSosDev) {
        currentEmergencyDeviceId = activeSosDev.id;
        currentEmergencyCoords = [activeSosDev.latitude, activeSosDev.longitude];
        setEmergencyButtonState(true, activeSosDev.id);
    } else {
        currentEmergencyDeviceId = null;
        setEmergencyButtonState(false);
    }

    if (data.emergency && currentAlertId !== data.emergency.alert_id) {
        currentAlertId = data.emergency.alert_id;
        currentEmergencyDeviceId = data.emergency.device_id;
        currentEmergencyCoords = [data.emergency.latitude, data.emergency.longitude];
        map.flyTo([data.emergency.latitude, data.emergency.longitude], 15, { animate: true, duration: 1.2 });
        document.getElementById('sos-modal-name').innerText = data.emergency.device_name;
        document.getElementById('sos-modal-deveui').innerText = data.emergency.dev_eui;
        document.getElementById('sos-modal-phone').innerText = `${data.emergency.customer_name} (${data.emergency.emergency_phone})`;
        document.getElementById('sos-modal-loc').innerText = `${data.emergency.latitude}, ${data.emergency.longitude}`;
        document.getElementById('sos-modal-time').innerText = data.emergency.created_at;

        const notesRow = document.getElementById('sos-modal-notes-row');
        const notesEl = document.getElementById('sos-modal-notes');
        const sosNotesInput = document.getElementById('sos-notes');
        const cleanNotes = (data.emergency.notes || '').trim();
        if (cleanNotes && !cleanNotes.includes('Tín hiệu vô tuyến')) {
            if (notesRow) notesRow.classList.remove('hidden');
            if (notesEl) notesEl.innerText = cleanNotes;
            if (sosNotesInput) sosNotesInput.value = cleanNotes;
        } else {
            if (notesRow) notesRow.classList.add('hidden');
            if (notesEl) notesEl.innerText = '';
            if (sosNotesInput) sosNotesInput.value = '';
        }

        document.getElementById('step3-box').classList.remove('hidden');
        document.getElementById('step4-5-box').classList.add('hidden');
        document.getElementById('emergency-modal').classList.remove('hidden');
        startSiren();
    }

    // Tự động cập nhật bảng danh sách thiết bị, lịch sử sự kiện và các thẻ thống kê thời gian thực (0ms delay)
    if (data.devices) {
        updateDeviceTableRealtime(data.devices);
    }
    if (data.alerts) {
        updateAlertsTableRealtime(data.alerts);
    }
}
window.refreshMapMarkers = refreshMapMarkers;

// Chuyển sang hiển thị Tab bản đồ mà không bị đè view nếu keepView=true
function showMapTab(keepView = false) {
    const allSections = ['map', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
    allSections.forEach(s => {
        const el = document.getElementById(`section-${s}`);
        if (el) el.classList.add('hidden');
    });

    const allBtns = ['map', 'playback', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
    allBtns.forEach(b => {
        const btn = document.getElementById(`tab-btn-${b}`);
        if (btn) btn.classList.remove('hc-nav-active');
    });

    const activeBtn = document.getElementById('tab-btn-map');
    if (activeBtn) activeBtn.classList.add('hc-nav-active');

    const pbToolbar = document.getElementById('playback-toolbar');
    if (pbToolbar) pbToolbar.classList.add('hidden');

    const pbPlayer = document.getElementById('playback-player-bar');
    if (pbPlayer) pbPlayer.classList.add('hidden');

    const filterBox = document.getElementById('map-filter-box');
    if (filterBox) filterBox.classList.remove('hidden');

    const mapSec = document.getElementById('section-map');
    if (mapSec) mapSec.classList.remove('hidden');

    // Đồng bộ trạng thái active cho thanh điều hướng di động (Mobile Bottom Nav) & đóng drawer
    try {
        document.querySelectorAll('.hc-mobile-nav-item').forEach(b => b.classList.remove('active'));
        const mobileBtn = document.getElementById('mobile-nav-btn-map');
        if (mobileBtn) mobileBtn.classList.add('active');
        if (typeof closeMobileSidebar === 'function') {
            closeMobileSidebar();
        }
    } catch (e) { }

    if (typeof map !== 'undefined' && map) {
        map.invalidateSize();
        if (!keepView) {
            map.closePopup();
            if (!fitMapToDevices(true, 1.2)) {
                map.setView(DEFAULT_MAP_CENTER, 12);
            }
        }
    }
}

// Zoom lại vị trí thiết bị đang cảnh báo và tự động mở popup chứa nút tắt cảnh báo tắt còi
function zoomAndOpenEmergencyPopup() {
    if (typeof map === 'undefined' || !map) return;
    map.invalidateSize();

    let targetCoords = currentEmergencyCoords;
    let targetDeviceId = currentEmergencyDeviceId;

    // Tìm fallback nếu biến chưa có
    if (!targetDeviceId || !targetCoords) {
        for (const id in deviceMarkersMap) {
            if (deviceMarkersMap[id].status === 'SOS' || deviceMarkersMap[id].status === 'PROCESSING') {
                targetDeviceId = parseInt(id);
                const pos = deviceMarkersMap[id].marker.getLatLng();
                targetCoords = [pos.lat, pos.lng];
                break;
            }
        }
    }

    if (!targetCoords) {
        const locText = document.getElementById('sos-modal-loc')?.innerText;
        if (locText && locText.includes(',')) {
            const parts = locText.split(',').map(s => parseFloat(s.trim()));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                targetCoords = parts;
            }
        }
    }

    if (targetCoords) {
        map.flyTo(targetCoords, 16, { animate: true, duration: 0.8 });
    }

    let opened = false;
    const tryOpen = () => {
        if (opened) return;
        if (targetDeviceId && deviceMarkersMap[targetDeviceId] && deviceMarkersMap[targetDeviceId].marker) {
            opened = true;
            deviceMarkersMap[targetDeviceId].marker.openPopup();
        }
    };

    map.once('moveend', tryOpen);
    setTimeout(tryOpen, 600);
}

function closeEmergencyModal() {
    const modal = document.getElementById('emergency-modal');
    if (!modal) return;

    const step3Box = document.getElementById('step3-box');
    // Nếu step3-box không bị ẩn nghĩa là người dùng CHƯA bấm "Xác nhận tiếp nhận cứu hộ (tắt còi)"
    const isUnacknowledged = step3Box && !step3Box.classList.contains('hidden');

    modal.classList.add('hidden');

    if (isUnacknowledged) {
        // Đóng popup mà KHÔNG bấm xác nhận cứu hộ tắt còi:
        // 1. Không tắt còi (còi báo động vẫn tiếp tục kêu)
        // 2. Chuyển sang tab bản đồ nếu đang ở tab khác (giữ nguyên không reset view)
        showMapTab(true);
        // 3. Zoom lại vị trí thiết bị đang cảnh báo và tự động mở popup của thiết bị đó trên bản đồ
        zoomAndOpenEmergencyPopup();
    } else {
        // Đã bấm xác nhận tiếp nhận cứu hộ (hoặc đang ở bước 4-5)
        stopSiren();
    }
}

async function acknowledgeSOS() {
    stopSiren();
    if (currentAlertId) {
        try {
            await fetch(`/api/alerts/${currentAlertId}/process/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'acknowledge' })
            });
        } catch (err) {
            console.error("Lỗi xác nhận tiếp nhận:", err);
        }
    }
    document.getElementById('step3-box').classList.add('hidden');
    document.getElementById('step4-5-box').classList.remove('hidden');
    refreshMapMarkers();
}

async function saveCoordinationNotes() {
    const notes = (document.getElementById('sos-notes')?.value || '').trim();
    if (currentAlertId) {
        try {
            await fetch(`/api/alerts/${currentAlertId}/process/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'update_notes', notes: notes })
            });
        } catch (err) {
            console.error("Lỗi lưu ghi chú:", err);
        }
    }
    alert("Đã lưu ghi chú điều phối cứu hộ!");
    closeEmergencyModal();
    refreshMapMarkers();
}

async function resolveSOS() {
    const notes = (document.getElementById('sos-notes')?.value || '').trim();
    const reportInput = (document.getElementById('sos-report')?.value || '').trim();
    const report = reportInput || 'Đã tiếp nhận & hoàn tất điều phối cứu hộ';

    // 1. Tắt còi và ẩn popup NGAY LẬP TỨC để người dùng không bị kẹt
    stopSiren();
    currentEmergencyDeviceId = null;
    currentEmergencyCoords = null;
    closeEmergencyModal();

    // 2. Lấy ID sự cố cần đóng (nếu currentAlertId bị null thì tra cứu từ máy chủ)
    let targetAlertId = currentAlertId;
    if (!targetAlertId) {
        try {
            const stateRes = await fetch('/api/state/');
            const stateData = await stateRes.json();
            if (stateData.emergency && stateData.emergency.alert_id) {
                targetAlertId = stateData.emergency.alert_id;
            }
        } catch (e) {
            console.error("Lỗi tra cứu trạng thái sự cố:", e);
        }
    }

    if (targetAlertId) {
        try {
            await fetch(`/api/alerts/${targetAlertId}/process/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'resolve',
                    notes: notes,
                    resolution_report: report
                })
            });
        } catch (err) {
            console.error("Lỗi khi gửi yêu cầu hoàn tất hồ sơ:", err);
        }
    }

    currentAlertId = null;
    refreshMapMarkers();
}

function openCoordinationModal(alertId, name, deveui) {
    currentAlertId = alertId;
    document.getElementById('sos-modal-name').innerText = name;
    document.getElementById('sos-modal-deveui').innerText = deveui;
    document.getElementById('step3-box').classList.add('hidden');
    document.getElementById('step4-5-box').classList.remove('hidden');
    document.getElementById('emergency-modal').classList.remove('hidden');
}

async function turnOffDeviceAlert(deviceId) {
    // 1. Dừng ngay còi báo động để lập tức giảm ồn
    stopSiren();

    try {
        const res = await fetch(`/api/devices/${deviceId}/turn_off_alert/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resolve_by_device' })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            currentAlertId = null;
            currentEmergencyDeviceId = null;
            currentEmergencyCoords = null;
            const modal = document.getElementById('emergency-modal');
            if (modal) modal.classList.add('hidden');
            if (typeof map !== 'undefined' && map) map.closePopup();
            refreshMapMarkers();
        } else {
            alert("❌ Lỗi: " + (data.message || "Không thể tắt cảnh báo"));
        }
    } catch (err) {
        console.error("Lỗi khi tắt cảnh báo:", err);
        alert("❌ Lỗi kết nối khi gửi yêu cầu tắt cảnh báo!");
    }
}
window.turnOffDeviceAlert = turnOffDeviceAlert;

// ================= 5. PLAYBACK XEM LẠI HÀNH TRÌNH GPS =================
let routePoints = [];
let playTimer = null;
let playIndex = 0;
let playSpeedMultiplier = 1;
let movingMarker = null;

async function loadRouteHistory() {
    const devId = document.getElementById('playback-device').value;
    const range = document.getElementById('playback-range').value;
    if (!devId) return alert("Vui lòng chọn một thiết bị có GPS!");

    const res = await fetch(`/api/devices/${devId}/route/?range=${range}`);
    const data = await res.json();
    routePoints = data.points;
    document.getElementById('route-distance').innerText = `${data.total_distance_km} km`;

    routeLayer.clearLayers();
    if (routePoints.length === 0) {
        const slider = document.getElementById('route-slider');
        if (slider) {
            slider.max = 0;
            slider.value = 0;
        }
        const timeEl = document.getElementById('route-current-time');
        if (timeEl) timeEl.innerText = 'Không có dữ liệu';
        const stepEl = document.getElementById('route-step-indicator');
        if (stepEl) stepEl.innerText = 'Điểm: 0 / 0';
        const statusEl = document.getElementById('route-point-status');
        if (statusEl) statusEl.innerHTML = '';
        return alert("Không có dữ liệu tọa độ trong khoảng thời gian này.");
    }

    const latlngs = routePoints.map(p => [p.lat, p.lng]);

    // 1. ĐỔI ĐƯỜNG ĐI SANG MÀU CAM NỔI BẬT TRÊN NỀN BIỂN
    L.polyline(latlngs, { color: '#7c2d12', weight: 6, opacity: 0.6 }).addTo(routeLayer);
    L.polyline(latlngs, { color: '#ff6600', weight: 4, opacity: 0.95 }).addTo(routeLayer);
    map.fitBounds(latlngs);

    // 2. HIỂN THỊ TỪNG ĐIỂM BÁO CÁO GPS, ĐIỂM DỪNG & LOGO CẢNH BÁO SOS
    routePoints.forEach((pt, idx) => {
        const isStart = idx === 0;
        const isEnd = idx === routePoints.length - 1;

        if (pt.is_sos) {
            // 🚨 ĐIỂM PHÁT BÁO ĐỘNG SOS KHẨN CẤP (ƯU TIÊN HIỂN THỊ HÀNG ĐẦU VỚI LOGO CẢNH BÁO)
            const badgeLabel = isEnd ? '🚨 SOS (Điểm cuối)' : (isStart ? '🚨 SOS (Xuất phát)' : '🚨 SOS');
            const sosIcon = L.divIcon({
                className: '',
                html: `
                    <div class="relative flex items-center justify-center cursor-pointer group" style="width: 40px; height: 40px;" title="CẢNH BÁO: Điểm phát tín hiệu SOS khẩn cấp!">
                        <span class="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping"></span>
                        <div class="relative w-9 h-9 rounded-full bg-red-600 border-2 border-white flex items-center justify-center text-amber-300 text-base shadow-xl font-bold ring-2 ring-red-400 group-hover:scale-110 transition-transform">
                            <i class="fa-solid fa-triangle-exclamation animate-pulse"></i>
                        </div>
                        <div class="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-red-700 text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shadow border border-white whitespace-nowrap">
                            ${badgeLabel}
                        </div>
                    </div>
                `,
                iconSize: [40, 48],
                iconAnchor: [20, 20]
            });
            const sosPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[230px]">
                    <div class="font-bold text-sm text-red-600 border-b border-red-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-triangle-exclamation text-amber-500 text-base"></i>
                        <span>ĐIỂM PHÁT BÁO ĐỘNG SOS</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời điểm gửi SOS:</strong> <span class="text-red-700 font-semibold">${pt.time}</span></div>
                        ${pt.button_name ? `<div><strong>Nguồn phát SOS:</strong> <span class="text-red-700 font-bold bg-red-100 px-1.5 py-0.5 rounded text-[11px]"><i class="fa-solid fa-hand-pointer mr-1"></i>${pt.button_name}</span></div>` : ''}
                        <div><strong>Tình trạng:</strong> <span class="bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold text-[11px]">⚠️ BÁO ĐỘNG KHẨN CẤP!</span></div>
                        <div><strong>Vận tốc lúc đó:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                        ${isEnd ? '<div class="text-[11px] text-sky-700 font-semibold mt-1">🏁 Đây cũng là vị trí ghi nhận cuối cùng</div>' : ''}
                        ${isStart ? '<div class="text-[11px] text-emerald-700 font-semibold mt-1">🚩 Đây cũng là điểm xuất phát</div>' : ''}
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua đến điểm SOS này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: sosIcon, zIndexOffset: 1500 }).addTo(routeLayer).bindPopup(sosPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else if (isStart) {
            // 🚩 ĐIỂM XUẤT PHÁT
            const startIcon = L.divIcon({
                className: '',
                html: `<div class="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded shadow-md border border-white whitespace-nowrap cursor-pointer transition">🚩 Xuất phát</div>`,
                iconSize: [68, 20],
                iconAnchor: [34, 20]
            });
            const startPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-emerald-700 border-b border-emerald-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <span>🚩</span> <span>ĐIỂM XUẤT PHÁT</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian xuất phát:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> Bắt đầu hành trình</div>
                        <div><strong>Vận tốc ban đầu:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(0)" class="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua về điểm xuất phát
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: startIcon, zIndexOffset: 1000 }).addTo(routeLayer).bindPopup(startPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(0, false); });
        } else if (isEnd) {
            // ⚓ ĐIỂM KẾT THÚC / HIỆN TẠI
            const endIcon = L.divIcon({
                className: '',
                html: `<div class="px-2 py-0.5 bg-sky-700 hover:bg-sky-800 text-white text-[10px] font-bold rounded shadow-md border border-white whitespace-nowrap cursor-pointer transition">⚓ Điểm cuối</div>`,
                iconSize: [68, 20],
                iconAnchor: [34, 20]
            });
            const endPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-sky-800 border-b border-sky-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-flag-checkered text-sky-600"></i> <span>ĐIỂM HIỆN TẠI / KẾT THÚC</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> Vị trí cuối hành trình</div>
                        <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-sky-700 hover:bg-sky-800 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua đến điểm cuối
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: endIcon, zIndexOffset: 1000 }).addTo(routeLayer).bindPopup(endPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else if (pt.speed === 0 || pt.is_drifting) {
            // ⏸ ĐIỂM DỪNG HOẶC ĐỖ
            const stopIcon = L.divIcon({
                className: '',
                html: `<div class="w-5 h-5 rounded-full bg-amber-500 border-2 border-white flex items-center justify-center text-white text-[9px] shadow-md hover:scale-150 transition cursor-pointer" title="Điểm dừng / đỗ #${idx + 1}"><i class="fa-solid fa-pause"></i></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            const stopPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-amber-600 border-b border-amber-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-pause text-amber-600"></i> <span>ĐIỂM DỪNG / ĐỖ #${idx + 1}</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian ghi nhận:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> <span class="text-amber-600 font-bold">${pt.is_drifting ? 'Đang trôi / không di chuyển' : 'Đang dừng / đỗ (0 km/h)'}</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua đến điểm này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: stopIcon, zIndexOffset: 500 }).addTo(routeLayer).bindPopup(stopPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else if (pt.packet_type === 'HEARTBEAT' || (!pt.is_sos && pt.has_button)) {
            // 🔘 ĐIỂM HEARTBEAT BÌNH THƯỜNG CỦA NÚT LIÊN KẾT (KHÔNG PHẢI SOS)
            const hbIcon = L.divIcon({
                className: '',
                html: `<div class="w-4 h-4 rounded-full bg-teal-500 border-2 border-white shadow hover:scale-175 transition-all cursor-pointer ring-1 ring-teal-700/30 flex items-center justify-center text-[8px] text-white" title="Heartbeat định kỳ: ${pt.button_name || 'Nút nhấn'} (${pt.time})"><i class="fa-solid fa-signal"></i></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            });
            const hbPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-teal-800 border-b border-teal-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-circle-check text-teal-600"></i> <span>TÍN HIỆU HEARTBEAT BÌNH THƯỜNG</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời điểm:</strong> ${pt.time}</div>
                        <div><strong>Trạng thái:</strong> <span class="bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded font-bold text-[11px]">✔ Bình thường (Hoạt động tốt)</span></div>
                        ${pt.button_name ? `<div><strong>Nút nhấn gửi:</strong> <span class="font-bold text-teal-700">${pt.button_name}</span></div>` : ''}
                        <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua đến điểm này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: hbIcon, zIndexOffset: 400 }).addTo(routeLayer).bindPopup(hbPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else {
            // 📍 ĐIỂM BÁO CÁO GPS ĐỊNH KỲ DỌC THEO HÀNH TRÌNH
            const waypointIcon = L.divIcon({
                className: '',
                html: `<div class="w-3.5 h-3.5 rounded-full bg-sky-500 border-2 border-white shadow hover:scale-175 hover:bg-orange-500 transition-all cursor-pointer ring-1 ring-sky-700/30" title="Báo cáo GPS: ${pt.time} (${pt.speed} km/h)"></div>`,
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            });
            const waypointPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-sky-800 border-b border-sky-200 pb-1 mb-1.5 flex items-center justify-between">
                        <span class="flex items-center gap-1"><i class="fa-solid fa-location-dot text-sky-500"></i> BÁO CÁO GPS #${idx + 1}</span>
                        <span class="text-[10px] font-bold text-sky-700 bg-sky-100 px-1.5 py-0.5 rounded">${pt.speed} km/h</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian:</strong> ⏱ ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> <span class="text-emerald-600 font-medium">Đang di chuyển</span></div>
                        <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-location-dot"></i> Tua đến điểm này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: waypointIcon, zIndexOffset: 300 }).addTo(routeLayer).bindPopup(waypointPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        }
    });

    // 3. MARKER PHƯƠNG TIỆN / THIẾT BỊ DI CHUYỂN TRÊN HÀNH TRÌNH
    const movingMarkerIcon = L.divIcon({
        className: '',
        html: `<div class="w-8 h-8 rounded-full bg-orange-600 border-2 border-white flex items-center justify-center text-white text-xs shadow-xl ring-4 ring-orange-300">
            <i class="fa-solid fa-location-dot"></i>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    movingMarker = L.marker(latlngs[0], { icon: movingMarkerIcon, zIndexOffset: 2000 }).addTo(routeLayer);
    movingMarker.bindPopup('', { autoClose: true, closeOnClick: true });

    document.getElementById('route-slider').max = routePoints.length - 1;
    document.getElementById('route-slider').value = 0;
    playIndex = 0;
    seekRoute(0);
}

function togglePlayRoute() {
    if (!routePoints || routePoints.length === 0) return alert("Vui lòng chọn thiết bị và tải hành trình trước khi phát!");
    if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
        document.getElementById('btn-play').innerHTML = '<i class="fa-solid fa-play"></i>';
    } else {
        if (playIndex >= routePoints.length - 1) {
            playIndex = 0;
            seekRoute(0);
        }
        document.getElementById('btn-play').innerHTML = '<i class="fa-solid fa-pause"></i>';
        playTimer = setInterval(() => {
            if (playIndex >= routePoints.length - 1) {
                togglePlayRoute();
                return;
            }
            playIndex++;
            seekRoute(playIndex);
        }, 800 / playSpeedMultiplier);
    }
}

function seekRoute(idx, openShipPopup = true) {
    if (!routePoints || routePoints.length === 0) return;
    playIndex = parseInt(idx);
    if (playIndex < 0) playIndex = 0;
    if (playIndex >= routePoints.length) playIndex = routePoints.length - 1;

    const pt = routePoints[playIndex];
    if (!pt || !movingMarker) return;

    movingMarker.setLatLng([pt.lat, pt.lng]);

    let statusText = '<span class="text-emerald-600 font-semibold">Đang di chuyển</span>';
    let badgeHtml = '<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30 text-[11px]"><i class="fa-solid fa-location-dot mr-1"></i>Di chuyển</span>';
    if (pt.is_sos) {
        statusText = '<span class="text-red-600 font-bold uppercase">🚨 Báo động SOS khẩn cấp!</span>';
        badgeHtml = '<span class="px-2 py-0.5 rounded-full bg-red-600/20 text-red-400 font-bold border border-red-500/30 text-[11px] animate-pulse"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Báo động SOS</span>';
    } else if (pt.speed === 0 || pt.is_drifting) {
        statusText = '<span class="text-amber-600 font-bold">⏸ Đang dừng / đỗ</span>';
        badgeHtml = '<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/30 text-[11px]"><i class="fa-solid fa-pause mr-1"></i>Dừng / Đỗ</span>';
    }

    const popupHtml = `
        <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
            <div class="font-bold text-sm text-orange-600 border-b pb-1 mb-1 flex items-center gap-1.5">
                <i class="fa-solid fa-location-dot text-orange-600"></i> <span>VỊ TRÍ HÀNH TRÌNH GPS</span>
            </div>
            <div class="space-y-1">
                <div><strong>Thời gian:</strong> ⏱ ${pt.time}</div>
                <div><strong>Tình trạng:</strong> ${statusText}</div>
                <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
            </div>
        </div>
    `;

    // Cập nhật duy nhất 1 popup của movingMarker, TUYỆT ĐỐI không sinh thêm popup mới khi kéo tua
    movingMarker.setPopupContent(popupHtml);
    if (openShipPopup) {
        if (!movingMarker.isPopupOpen()) {
            movingMarker.openPopup();
        }
    }

    const slider = document.getElementById('route-slider');
    if (slider) slider.value = playIndex;
    const speedEl = document.getElementById('route-speed');
    if (speedEl) speedEl.innerText = `${pt.speed} km/h`;

    const timeEl = document.getElementById('route-current-time');
    if (timeEl) timeEl.innerText = pt.time || '--:--:--';
    const stepEl = document.getElementById('route-step-indicator');
    if (stepEl) stepEl.innerText = `Điểm: ${playIndex + 1} / ${routePoints.length}`;
    const statusEl = document.getElementById('route-point-status');
    if (statusEl) statusEl.innerHTML = badgeHtml;
}
window.seekRoute = seekRoute;

function stepRoute(step) {
    if (!routePoints || routePoints.length === 0) return;
    let nextIdx = playIndex + step;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= routePoints.length) nextIdx = routePoints.length - 1;
    seekRoute(nextIdx);
}
window.stepRoute = stepRoute;

function changeSpeed(val) {
    playSpeedMultiplier = parseInt(val);
    if (playTimer) {
        togglePlayRoute();
        togglePlayRoute();
    }
}

function exportRouteKML() {
    if (routePoints.length === 0) return alert("Hãy tải hành trình trước khi xuất file KML!");
    const coords = routePoints.map(p => `${p.lng},${p.lat},0`).join(' ');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Hanh Trinh Cuu Ho</name>
    <LineString><coordinates>${coords}</coordinates></LineString></Placemark></Document></kml>`;
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Hanh_Trinh_Cuu_Ho_Bien.kml';
    a.click();
}

// ================= 6. ĐĂNG KÝ THIẾT BỊ, CHUYỂN TAB & THỐNG KÊ =================
function toggleStaticAddressField() {
    const hasGps = document.getElementById('reg-has-gps')?.value === 'true';
    const addrLabel = document.getElementById('reg-address-label');
    const addrInput = document.getElementById('reg-address');
    if (addrLabel) {
        addrLabel.innerText = hasGps ? "Cảng neo đậu / Khu vực hoạt động:" : "Địa chỉ lắp đặt / Nhà ở cơ sở:";
    }
    if (addrInput) {
        addrInput.placeholder = hasGps
            ? "Ví dụ: Cảng Tiên Sa, Bến thuyền Sơn Trà, Cửa Đại, Vịnh Đà Nẵng..."
            : "Ví dụ: Số 123 đường Bạch Đằng, P. Hải Châu 1, Đà Nẵng...";
    }
}

function openAddDeviceModal() {
    const modal = document.getElementById('add-device-modal');
    if (modal) modal.classList.remove('hidden');
    const statusMsg = document.getElementById('reg-device-status-msg');
    if (statusMsg) statusMsg.classList.add('hidden');
    const devTypeEl = document.getElementById('reg-device-type');
    if (devTypeEl) devTypeEl.value = 'NUT_NHAN';
    loadHCTechGroupsAndPackages();
    setTimeout(() => {
        initRegMiniMap(16.054407, 108.202167);
    }, 250);
}
function closeAddDeviceModal() {
    const modal = document.getElementById('add-device-modal');
    if (modal) modal.classList.add('hidden');
}

// ================= BẢN ĐỒ & TỌA ĐỘ KHI TẠO THIẾT BỊ MỚI =================
let regMiniMap = null;
let regMiniMarker = null;
let regGeoDebounceTimer = null;
let regLastSuggestedResults = [];

function initRegMiniMap(initialLat, initialLng) {
    const mapEl = document.getElementById('reg-mini-map');
    if (!mapEl) return;

    const defaultLat = 16.054407;
    const defaultLng = 108.202167;
    const hasInitialCoords = (initialLat !== undefined && initialLat !== null && initialLat !== '' && !isNaN(initialLat) &&
        initialLng !== undefined && initialLng !== null && initialLng !== '' && !isNaN(initialLng));

    const lat = hasInitialCoords ? parseFloat(initialLat) : defaultLat;
    const lng = hasInitialCoords ? parseFloat(initialLng) : defaultLng;

    if (!regMiniMap) {
        regMiniMap = L.map('reg-mini-map', {
            center: [lat, lng],
            zoom: hasInitialCoords ? 15 : 13,
            zoomControl: true,
            attributionControl: false
        });

        L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '© Google Maps',
            maxZoom: 20
        }).addTo(regMiniMap);

        const pinIcon = L.divIcon({
            className: 'hc-custom-reg-pin',
            html: `<div style="width:26px;height:26px;border-radius:50%;background:#0284c7;color:#ffffff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(2,132,199,0.4);border:2px solid #ffffff;font-size:12px;cursor:grab;">
                     <i class="fa-solid fa-location-dot"></i>
                   </div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 26]
        });

        regMiniMarker = L.marker([lat, lng], {
            draggable: true,
            icon: pinIcon
        }).addTo(regMiniMap);

        // Kéo ghim trực tiếp trên bản đồ
        regMiniMarker.on('dragend', function (e) {
            const pos = e.target.getLatLng();
            setRegCoords(pos.lat, pos.lng, true);
        });

        // Bấm trực tiếp lên bản đồ để chọn vị trí
        regMiniMap.on('click', function (e) {
            setRegCoords(e.latlng.lat, e.latlng.lng, true);
        });
    } else {
        regMiniMap.setView([lat, lng], hasInitialCoords ? 15 : 13);
        if (regMiniMarker) {
            regMiniMarker.setLatLng([lat, lng]);
        }
    }

    updateRegCoordsBadge(lat, lng);

    setTimeout(() => {
        if (regMiniMap) regMiniMap.invalidateSize();
    }, 250);
}

function setRegCoords(lat, lng, doReverseGeocode = false, zoomLevel = null) {
    const latInput = document.getElementById('reg-lat');
    const lngInput = document.getElementById('reg-lng');

    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
        if (latInput) latInput.value = '';
        if (lngInput) lngInput.value = '';
        updateRegCoordsBadge(null, null);
        return;
    }

    const flat = parseFloat(Number(lat).toFixed(6));
    const flng = parseFloat(Number(lng).toFixed(6));

    if (latInput) latInput.value = flat;
    if (lngInput) lngInput.value = flng;

    updateRegCoordsBadge(flat, flng);

    if (regMiniMarker) {
        regMiniMarker.setLatLng([flat, flng]);
    }
    if (regMiniMap) {
        const targetZoom = zoomLevel || Math.max(regMiniMap.getZoom(), 17);
        if (typeof regMiniMap.flyTo === 'function') {
            regMiniMap.flyTo([flat, flng], targetZoom, { duration: 1.0 });
        } else {
            regMiniMap.setView([flat, flng], targetZoom);
        }
    }

    if (doReverseGeocode) {
        fetchRegReverseGeocode(flat, flng);
    }
}

function updateRegCoordsBadge(lat, lng) {
    const badge = document.getElementById('reg-coords-badge');
    if (!badge) return;
    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
        badge.innerHTML = `<i class="fa-solid fa-location-dot mr-1"></i>${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
        badge.className = 'font-mono text-[10px] px-2.5 py-0.5 rounded-full border border-sky-500/40 text-sky-600 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40';
    } else {
        badge.innerHTML = `<i class="fa-solid fa-location-crosshairs mr-1"></i>Chưa chọn vị trí`;
        badge.className = 'font-mono text-[10px] px-2.5 py-0.5 rounded-full border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/60';
    }
}

function centerRegMiniMap() {
    const latVal = parseFloat(document.getElementById('reg-lat')?.value);
    const lngVal = parseFloat(document.getElementById('reg-lng')?.value);
    if (!isNaN(latVal) && !isNaN(lngVal) && regMiniMap) {
        if (typeof regMiniMap.flyTo === 'function') {
            regMiniMap.flyTo([latVal, lngVal], 17, { duration: 0.8 });
        } else {
            regMiniMap.setView([latVal, lngVal], 17);
        }
    } else if (regMiniMap) {
        regMiniMap.setView([16.054407, 108.202167], 13);
    }
}

async function fetchRegReverseGeocode(lat, lng) {
    const statusEl = document.getElementById('reg-geo-status');
    const addrInput = document.getElementById('reg-address');
    const clearBtn = document.getElementById('btn-clear-reg-address');
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lấy tên địa chỉ...';
        statusEl.classList.remove('hidden');
    }
    try {
        const res = await fetch(`/api/geo/reverse/?lat=${lat}&lng=${lng}`);
        const data = await res.json();
        if (data.status === 'success' && data.display_name) {
            if (addrInput) addrInput.value = data.display_name;
            if (clearBtn) clearBtn.classList.remove('hidden');
        }
    } catch (err) {
        console.warn("Reg reverse geocode failed:", err);
    } finally {
        if (statusEl) statusEl.classList.add('hidden');
    }
}

function onRegAddressInput(val) {
    const clearBtn = document.getElementById('btn-clear-reg-address');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val.trim());
    }

    if (regGeoDebounceTimer) clearTimeout(regGeoDebounceTimer);

    const query = val.trim();
    if (query.length < 2) {
        hideRegAddressSuggestions();
        return;
    }

    regGeoDebounceTimer = setTimeout(() => {
        fetchRegAddressSuggestions(query);
    }, 280);
}

function onRegAddressFocus() {
    const val = (document.getElementById('reg-address')?.value || '').trim();
    if (val.length >= 2 && regLastSuggestedResults.length > 0) {
        renderRegAddressSuggestions(regLastSuggestedResults);
    }
}

function clearRegAddress() {
    const addrInput = document.getElementById('reg-address');
    if (addrInput) {
        addrInput.value = '';
        addrInput.focus();
    }
    const clearBtn = document.getElementById('btn-clear-reg-address');
    if (clearBtn) clearBtn.classList.add('hidden');
    hideRegAddressSuggestions();
}

async function fetchRegAddressSuggestions(q) {
    const statusEl = document.getElementById('reg-geo-status');
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tìm gợi ý...';
        statusEl.classList.remove('hidden');
    }

    try {
        const res = await fetch(`/api/geo/suggest/?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.status === 'success' && data.results && data.results.length > 0) {
            regLastSuggestedResults = data.results;
            renderRegAddressSuggestions(data.results);
        } else {
            renderRegEmptySuggestions();
        }
    } catch (err) {
        console.warn("Reg suggest error:", err);
        renderRegEmptySuggestions();
    } finally {
        if (statusEl) statusEl.classList.add('hidden');
    }
}

function renderRegAddressSuggestions(items) {
    const box = document.getElementById('reg-address-suggestions');
    if (!box) return;

    if (!items || items.length === 0) {
        renderRegEmptySuggestions();
        return;
    }

    let html = '';
    items.forEach((item, idx) => {
        const isHarbor = item.is_harbor;
        const iconClass = isHarbor ? 'fa-solid fa-anchor' : 'fa-solid fa-location-dot';
        const typeClass = isHarbor ? 'harbor' : 'location';
        const badgeLabel = isHarbor
            ? '<span class="text-[9px] font-bold text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-500/30 ml-1.5 shrink-0">Cảng / Bến</span>'
            : '';

        const titleText = escapeHtml(item.name || item.display_name.split(',')[0]);
        const subText = escapeHtml(item.display_name);

        html += `
        <div class="hc-geo-item ${typeClass}" onclick="selectRegAddress(${idx})">
          <div class="geo-icon">
            <i class="${iconClass}"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="geo-title truncate">${titleText}</span>
              ${badgeLabel}
            </div>
            <div class="geo-subtitle line-clamp-1">${subText}</div>
          </div>
        </div>`;
    });

    box.innerHTML = html;
    box.classList.remove('hidden');
}

function renderRegEmptySuggestions() {
    const box = document.getElementById('reg-address-suggestions');
    if (!box) return;
    box.innerHTML = `
      <div class="p-3 text-center text-xs hc-text-muted">
        <i class="fa-solid fa-circle-info mr-1 text-cyan-400"></i>
        Không tìm thấy gợi ý trùng khớp. Bạn có thể bấm trực tiếp lên bản đồ bên dưới để chọn vị trí.
      </div>
    `;
    box.classList.remove('hidden');
}

function hideRegAddressSuggestions() {
    const box = document.getElementById('reg-address-suggestions');
    if (box) box.classList.add('hidden');
}

function selectRegAddress(index) {
    const item = regLastSuggestedResults[index];
    if (!item) return;

    const addrInput = document.getElementById('reg-address');
    if (addrInput) addrInput.value = item.display_name;

    const clearBtn = document.getElementById('btn-clear-reg-address');
    if (clearBtn) clearBtn.classList.remove('hidden');

    // Zoom to vị trí địa chỉ được chọn lên mức 17 rất rõ ràng và chi tiết
    setRegCoords(item.lat, item.lng, false, 17);
    hideRegAddressSuggestions();
}

async function onRegAddressKeyDown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = (document.getElementById('reg-address')?.value || '').trim();
        if (!val) return;
        if (regLastSuggestedResults && regLastSuggestedResults.length > 0) {
            selectRegAddress(0);
        } else {
            const statusEl = document.getElementById('reg-geo-status');
            if (statusEl) {
                statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang định vị...';
                statusEl.classList.remove('hidden');
            }
            try {
                const res = await fetch(`/api/geo/suggest/?q=${encodeURIComponent(val)}`);
                const data = await res.json();
                if (data.status === 'success' && data.results && data.results.length > 0) {
                    regLastSuggestedResults = data.results;
                    selectRegAddress(0);
                }
            } catch (err) {
                console.warn("Reg geocode enter err:", err);
            } finally {
                if (statusEl) statusEl.classList.add('hidden');
            }
        }
    }
}


// ================= GÁN THÔNG TIN CHO THIẾT BỊ MỚI / SỬA THÔNG TIN =================
let assignMiniMap = null;
let assignMiniMarker = null;
let assignGeoDebounceTimer = null;
let lastSuggestedResults = [];

function toggleAssignGpsFields() {
    const hasGps = document.getElementById('assign-has-gps')?.value === 'true';
    const addrLabel = document.getElementById('assign-address-label');
    const addrInput = document.getElementById('assign-address');
    if (addrLabel) {
        addrLabel.innerText = hasGps ? "Cảng neo đậu / Khu vực hoạt động:" : "Địa chỉ lắp đặt / Nhà ở cơ sở:";
    }
    if (addrInput) {
        addrInput.placeholder = hasGps
            ? "Ví dụ: Cảng Tiên Sa, Bến thuyền Sơn Trà, Cửa Đại, Vịnh Đà Nẵng..."
            : "Ví dụ: Số 123 đường Bạch Đằng, P. Hải Châu 1, Đà Nẵng...";
    }
    const pairContainer = document.getElementById('assign-pairing-container');
    if (pairContainer) {
        pairContainer.style.display = hasGps ? 'none' : 'block';
    }
}

// Khởi tạo bản đồ Mini trong popup gán thông tin thiết bị
function initAssignMiniMap(initialLat, initialLng) {
    const mapEl = document.getElementById('assign-mini-map');
    if (!mapEl) return;

    const defaultLat = 16.0544;
    const defaultLng = 108.2022;
    const hasInitialCoords = (initialLat !== undefined && initialLat !== null && initialLat !== '' && !isNaN(initialLat) &&
        initialLng !== undefined && initialLng !== null && initialLng !== '' && !isNaN(initialLng));

    const lat = hasInitialCoords ? parseFloat(initialLat) : defaultLat;
    const lng = hasInitialCoords ? parseFloat(initialLng) : defaultLng;

    if (!assignMiniMap) {
        assignMiniMap = L.map('assign-mini-map', {
            center: [lat, lng],
            zoom: hasInitialCoords ? 15 : 12,
            zoomControl: true,
            attributionControl: false
        });

        L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '© Google Maps',
            maxZoom: 20
        }).addTo(assignMiniMap);

        const pinIcon = L.divIcon({
            className: 'hc-custom-assign-pin',
            html: `<div style="width:28px;height:28px;border-radius:50%;background:#0891b2;color:#ffffff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 14px rgba(8,145,178,0.85);border:2px solid #ffffff;font-size:13px;cursor:grab;">
                     <i class="fa-solid fa-location-dot"></i>
                   </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 28]
        });

        assignMiniMarker = L.marker([lat, lng], {
            draggable: true,
            icon: pinIcon
        }).addTo(assignMiniMap);

        // Kéo ghim trực tiếp trên bản đồ
        assignMiniMarker.on('dragend', function (e) {
            const pos = e.target.getLatLng();
            setAssignCoords(pos.lat, pos.lng, true);
        });

        // Bấm trực tiếp lên bản đồ để chọn vị trí
        assignMiniMap.on('click', function (e) {
            setAssignCoords(e.latlng.lat, e.latlng.lng, true);
        });
    } else {
        assignMiniMap.setView([lat, lng], hasInitialCoords ? 15 : 12);
        if (assignMiniMarker) {
            assignMiniMarker.setLatLng([lat, lng]);
        }
    }

    updateAssignCoordsBadge(hasInitialCoords ? lat : null, hasInitialCoords ? lng : null);

    // Bắt buộc tính lại kích thước để tránh bản đồ bị xám khi hiển thị trong modal
    setTimeout(() => {
        if (assignMiniMap) assignMiniMap.invalidateSize();
    }, 250);
}

// Cập nhật tọa độ vào hidden inputs và ghim bản đồ
function setAssignCoords(lat, lng, doReverseGeocode = false) {
    const latInput = document.getElementById('assign-lat');
    const lngInput = document.getElementById('assign-lng');

    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
        if (latInput) latInput.value = '';
        if (lngInput) lngInput.value = '';
        updateAssignCoordsBadge(null, null);
        return;
    }

    const flat = parseFloat(Number(lat).toFixed(6));
    const flng = parseFloat(Number(lng).toFixed(6));

    if (latInput) latInput.value = flat;
    if (lngInput) lngInput.value = flng;

    updateAssignCoordsBadge(flat, flng);

    if (assignMiniMarker) {
        assignMiniMarker.setLatLng([flat, flng]);
    }
    if (assignMiniMap) {
        assignMiniMap.panTo([flat, flng]);
    }

    if (doReverseGeocode) {
        fetchReverseGeocode(flat, flng);
    }
}

function updateAssignCoordsBadge(lat, lng) {
    const badge = document.getElementById('assign-coords-badge');
    if (!badge) return;
    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
        badge.innerHTML = `<i class="fa-solid fa-check mr-1"></i>Đã gán: ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
        badge.className = 'assigned';
    } else {
        badge.innerHTML = `<i class="fa-solid fa-location-crosshairs mr-1"></i>Chưa chọn vị trí`;
        badge.className = 'unassigned';
    }
}

function centerAssignMiniMap() {
    const latVal = parseFloat(document.getElementById('assign-lat')?.value);
    const lngVal = parseFloat(document.getElementById('assign-lng')?.value);
    if (!isNaN(latVal) && !isNaN(lngVal) && assignMiniMap) {
        assignMiniMap.setView([latVal, lngVal], 16);
    } else if (assignMiniMap) {
        assignMiniMap.setView([16.0544, 108.2022], 12);
    }
}

// Gọi API reverse geocode khi người dùng click/kéo ghim trên bản đồ
async function fetchReverseGeocode(lat, lng) {
    const statusEl = document.getElementById('assign-geo-status');
    const addrInput = document.getElementById('assign-address');
    const clearBtn = document.getElementById('btn-clear-assign-address');
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lấy tên địa chỉ...';
        statusEl.classList.remove('hidden');
    }
    try {
        const res = await fetch(`/api/geo/reverse/?lat=${lat}&lng=${lng}`);
        const data = await res.json();
        if (data.status === 'success' && data.display_name) {
            if (addrInput) addrInput.value = data.display_name;
            if (clearBtn) clearBtn.classList.remove('hidden');
        }
    } catch (err) {
        console.warn("Reverse geocode failed:", err);
    } finally {
        if (statusEl) statusEl.classList.add('hidden');
    }
}

// Xử lý khi người dùng gõ tìm địa chỉ hoặc cảng neo đậu
function onAssignAddressInput(val) {
    const clearBtn = document.getElementById('btn-clear-assign-address');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val.trim());
    }

    if (assignGeoDebounceTimer) clearTimeout(assignGeoDebounceTimer);

    const query = val.trim();
    if (query.length < 2) {
        hideAssignAddressSuggestions();
        return;
    }

    assignGeoDebounceTimer = setTimeout(() => {
        fetchAddressSuggestions(query);
    }, 280);
}

function onAssignAddressFocus() {
    const val = (document.getElementById('assign-address')?.value || '').trim();
    if (val.length >= 2 && lastSuggestedResults.length > 0) {
        renderAssignAddressSuggestions(lastSuggestedResults);
    }
}

function clearAssignAddress() {
    const addrInput = document.getElementById('assign-address');
    if (addrInput) {
        addrInput.value = '';
        addrInput.focus();
    }
    const clearBtn = document.getElementById('btn-clear-assign-address');
    if (clearBtn) clearBtn.classList.add('hidden');
    hideAssignAddressSuggestions();
}

async function fetchAddressSuggestions(q) {
    const statusEl = document.getElementById('assign-geo-status');
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tìm gợi ý...';
        statusEl.classList.remove('hidden');
    }

    try {
        const res = await fetch(`/api/geo/suggest/?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.status === 'success' && data.results && data.results.length > 0) {
            lastSuggestedResults = data.results;
            renderAssignAddressSuggestions(data.results);
        } else {
            renderEmptySuggestions();
        }
    } catch (err) {
        console.warn("Suggest error:", err);
        renderEmptySuggestions();
    } finally {
        if (statusEl) statusEl.classList.add('hidden');
    }
}

function renderAssignAddressSuggestions(items) {
    const box = document.getElementById('assign-address-suggestions');
    if (!box) return;

    if (!items || items.length === 0) {
        renderEmptySuggestions();
        return;
    }

    let html = '';
    items.forEach((item, idx) => {
        const isHarbor = item.is_harbor;
        const iconClass = isHarbor ? 'fa-solid fa-anchor' : 'fa-solid fa-location-dot';
        const typeClass = isHarbor ? 'harbor' : 'location';
        const badgeLabel = isHarbor
            ? '<span class="text-[9px] font-bold text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-500/30 ml-1.5 shrink-0">Cảng / Bến</span>'
            : '';

        const titleText = escapeHtml(item.name || item.display_name.split(',')[0]);
        const subText = escapeHtml(item.display_name);

        html += `
        <div class="hc-geo-item ${typeClass}" onclick="selectAssignAddress(${idx})">
          <div class="geo-icon">
            <i class="${iconClass}"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="geo-title truncate">${titleText}</span>
              ${badgeLabel}
            </div>
            <div class="geo-subtitle line-clamp-1">${subText}</div>
          </div>
        </div>`;
    });

    box.innerHTML = html;
    box.classList.remove('hidden');
}

function renderEmptySuggestions() {
    const box = document.getElementById('assign-address-suggestions');
    if (!box) return;
    box.innerHTML = `
      <div class="p-3 text-center text-xs hc-text-muted">
        <i class="fa-solid fa-circle-info mr-1 text-cyan-400"></i>
        Không tìm thấy gợi ý trùng khớp. Bạn có thể bấm trực tiếp lên bản đồ bên dưới để chọn vị trí.
      </div>
    `;
    box.classList.remove('hidden');
}

function hideAssignAddressSuggestions() {
    const box = document.getElementById('assign-address-suggestions');
    if (box) box.classList.add('hidden');
}

function selectAssignAddress(index) {
    const item = lastSuggestedResults[index];
    if (!item) return;

    const addrInput = document.getElementById('assign-address');
    if (addrInput) addrInput.value = item.display_name;

    const clearBtn = document.getElementById('btn-clear-assign-address');
    if (clearBtn) clearBtn.classList.remove('hidden');

    setAssignCoords(item.lat, item.lng, false);
    hideAssignAddressSuggestions();
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

document.addEventListener('click', function (e) {
    const group = document.getElementById('assign-address-group');
    if (group && !group.contains(e.target)) {
        hideAssignAddressSuggestions();
    }
    const regGroup = document.getElementById('reg-address-group');
    if (regGroup && !regGroup.contains(e.target)) {
        hideRegAddressSuggestions();
    }
});

function openAssignDeviceModal(deviceId, devEui, deviceName, customerName, phone, categoryType, address, hasGps, lat, lng, parentId, groupName, heartbeatInterval) {
    const modal = document.getElementById('assign-device-modal');
    if (!modal) {
        console.error("Không tìm thấy modal #assign-device-modal");
        return;
    }
    const idInput = document.getElementById('assign-dev-id');
    const euiInput = document.getElementById('assign-dev-eui');
    const nameInput = document.getElementById('assign-dev-name');
    const custInput = document.getElementById('assign-cust-name');
    const phoneInput = document.getElementById('assign-phone');
    const catInput = document.getElementById('assign-category');
    const gpsSelect = document.getElementById('assign-has-gps');
    const addrInput = document.getElementById('assign-address');
    const latInput = document.getElementById('assign-lat');
    const lngInput = document.getElementById('assign-lng');
    const parentSelect = document.getElementById('assign-parent-id');
    const groupInput = document.getElementById('assign-group-name');
    const hbInput = document.getElementById('assign-heartbeat-interval');

    if (idInput) idInput.value = deviceId || '';
    if (euiInput) euiInput.value = devEui || '';
    if (nameInput) nameInput.value = deviceName || '';
    if (custInput) custInput.value = customerName || '';
    if (phoneInput) phoneInput.value = phone || '';
    if (catInput) catInput.value = categoryType || 'CAP_CUU_Y_TE';
    if (gpsSelect) gpsSelect.value = (hasGps === true || hasGps === 'true' || hasGps === 1) ? 'true' : 'false';
    if (addrInput) addrInput.value = address || '';
    if (latInput) latInput.value = (lat !== undefined && lat !== null && lat !== 'None') ? lat : '';
    if (lngInput) lngInput.value = (lng !== undefined && lng !== null && lng !== 'None') ? lng : '';
    if (parentSelect) parentSelect.value = parentId || '';
    if (groupInput) groupInput.value = groupName || '';
    if (hbInput) hbInput.value = (heartbeatInterval !== undefined && heartbeatInterval !== null && heartbeatInterval !== '') ? heartbeatInterval : 300;

    const clearBtn = document.getElementById('btn-clear-assign-address');
    if (clearBtn) clearBtn.classList.toggle('hidden', !(address && address.trim()));

    toggleAssignGpsFields();

    modal.classList.remove('hidden');

    // Khởi tạo bản đồ mini với tọa độ thiết bị (hoặc mặc định)
    const initLat = (lat !== undefined && lat !== null && lat !== 'None' && lat !== '') ? parseFloat(lat) : null;
    const initLng = (lng !== undefined && lng !== null && lng !== 'None' && lng !== '') ? parseFloat(lng) : null;
    initAssignMiniMap(initLat, initLng);

    setTimeout(() => {
        if (custInput && !custInput.value) {
            custInput.focus();
        } else if (nameInput) {
            nameInput.focus();
        }
    }, 100);
}

function closeAssignDeviceModal() {
    const modal = document.getElementById('assign-device-modal');
    if (modal) modal.classList.add('hidden');
    hideAssignAddressSuggestions();
}

async function submitAssignDevice(e) {
    if (e) e.preventDefault();
    const deviceId = document.getElementById('assign-dev-id')?.value;
    if (!deviceId) return alert("Không tìm thấy mã thiết bị cần cập nhật!");

    const devName = document.getElementById('assign-dev-name')?.value.trim();
    const custName = document.getElementById('assign-cust-name')?.value.trim();
    const phone = document.getElementById('assign-phone')?.value.trim();
    const category = document.getElementById('assign-category')?.value || 'CAP_CUU_Y_TE';
    const hasGps = document.getElementById('assign-has-gps')?.value === 'true';
    const address = document.getElementById('assign-address')?.value.trim();
    const latVal = document.getElementById('assign-lat')?.value.trim();
    const lngVal = document.getElementById('assign-lng')?.value.trim();
    const hbVal = document.getElementById('assign-heartbeat-interval')?.value?.trim();

    if (!devName) return alert("Vui lòng nhập tên thiết bị hiển thị!");
    if (!custName) return alert("Vui lòng nhập tên chủ hộ / người quản lý / thuyền trưởng!");
    if (!phone) return alert("Vui lòng nhập số điện thoại khẩn cấp!");

    const btn = document.getElementById('btn-save-assign');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;
    }

    const parentIdVal = document.getElementById('assign-parent-id')?.value;
    const groupNameVal = document.getElementById('assign-group-name')?.value?.trim();

    try {
        const payload = {
            device_name: devName,
            customer_name: custName,
            emergency_phone: phone,
            category_type: category,
            has_gps: hasGps,
            address: address,
            parent_device_id: parentIdVal ? parseInt(parentIdVal) : null,
            group_name: groupNameVal || '',
            heartbeat_interval: parseInt(hbVal) || 300
        };
        if (latVal) payload.latitude = parseFloat(latVal);
        if (lngVal) payload.longitude = parseFloat(lngVal);

        const res = await fetch(`/api/devices/${deviceId}/update/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (res.ok && result.status === 'success') {
            closeAssignDeviceModal();
            alert("✅ " + (result.message || "Đã lưu thông tin thiết bị thành công!"));
            // Giữ lại tab hiện tại và tải lại để cập nhật toàn bộ bảng thiết bị và bản đồ
            sessionStorage.setItem('active_hc_tab', 'devices');
            location.reload();
        } else {
            alert("❌ " + (result.message || "Không thể cập nhật thông tin thiết bị!"));
        }
    } catch (err) {
        alert("❌ Lỗi kết nối khi cập nhật thông tin: " + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-check"></i> <span>Lưu thông tin</span>`;
        }
    }
}

// Chuyển sang trang bản đồ và zoom vào vị trí thiết bị khi người dùng nhấn vào thiết bị trong mục quản lý thiết bị
function zoomToDeviceOnMap(deviceId) {
    if (!deviceId) return;
    const devIdNum = parseInt(deviceId);

    // 1. Chuyển sang hiển thị Tab bản đồ mà không reset view
    showMapTab(true);
    sessionStorage.setItem('active_hc_tab', 'map');

    // 2. Chờ DOM hiển thị và invalidateSize Leaflet
    setTimeout(() => {
        if (typeof map === 'undefined' || !map) return;
        map.invalidateSize();

        const performFlyAndPopup = (lat, lng, markerInstance) => {
            map.flyTo([lat, lng], 17, { animate: true, duration: 1.0 });
            let opened = false;
            const tryOpen = () => {
                if (opened) return;
                const m = markerInstance || (deviceMarkersMap[devIdNum] && deviceMarkersMap[devIdNum].marker);
                if (m) {
                    opened = true;
                    m.openPopup();
                }
            };
            map.once('moveend', tryOpen);
            setTimeout(tryOpen, 750);
        };

        const entry = deviceMarkersMap[devIdNum];
        if (entry && entry.marker) {
            const latlng = entry.marker.getLatLng();
            performFlyAndPopup(latlng.lat, latlng.lng, entry.marker);
        } else {
            // Marker chưa có trong bộ nhớ bản đồ -> Fetch state từ API để lấy lat/lng
            fetch('/api/state/')
                .then(r => r.json())
                .then(data => {
                    const dev = (data.devices || []).find(x => x.id === devIdNum);
                    if (dev && dev.latitude != null && dev.longitude != null) {
                        const lat = parseFloat(dev.latitude);
                        const lng = parseFloat(dev.longitude);
                        if (!isNaN(lat) && !isNaN(lng)) {
                            refreshMapMarkers(false).then(() => {
                                const m = deviceMarkersMap[devIdNum]?.marker;
                                performFlyAndPopup(lat, lng, m);
                            });
                            return;
                        }
                    }
                    alert("Thiết bị này chưa có dữ liệu tọa độ vị trí để hiển thị trên bản đồ.");
                })
                .catch(err => {
                    console.error("Lỗi khi tải vị trí thiết bị:", err);
                });
        }
    }, 200);
}

function handleDeviceRowClick(event, deviceId) {
    // Không chuyển trang nếu người dùng click vào checkbox, button, link hoặc menu hành động
    if (event && event.target && event.target.closest('button, input, a, .dev-check, .cursor-not-allowed')) {
        return;
    }
    zoomToDeviceOnMap(deviceId);
}

// Đăng ký toàn cục vào window
window.toggleAssignGpsFields = toggleAssignGpsFields;
window.onAssignAddressInput = onAssignAddressInput;
window.onAssignAddressFocus = onAssignAddressFocus;
window.clearAssignAddress = clearAssignAddress;
window.selectAssignAddress = selectAssignAddress;
window.centerAssignMiniMap = centerAssignMiniMap;
window.closeAssignDeviceModal = closeAssignDeviceModal;
// Lưu danh sách thiết bị mới nhất để dùng nhanh cho modal gán thiết bị
let latestDevicesList = [];

function triggerAssignModal(deviceId) {
    if (!deviceId) return;
    const devIdNum = parseInt(deviceId);
    let dev = (latestDevicesList || []).find(x => x.id === devIdNum);
    if (dev) {
        openAssignDeviceModal(
            dev.id,
            dev.dev_eui,
            dev.device_name || '',
            dev.customer_name || '',
            dev.emergency_phone || '',
            dev.category_type || 'CAP_CUU_Y_TE',
            dev.address || '',
            Boolean(dev.has_gps),
            dev.latitude,
            dev.longitude,
            dev.parent_id || dev.parent_device_id || '',
            dev.group_name || '',
            dev.heartbeat_interval || 300
        );
        return;
    }
    fetch('/api/state/')
        .then(r => r.json())
        .then(data => {
            latestDevicesList = data.devices || [];
            const d = latestDevicesList.find(x => x.id === devIdNum);
            if (d) {
                openAssignDeviceModal(
                    d.id,
                    d.dev_eui,
                    d.device_name || '',
                    d.customer_name || '',
                    d.emergency_phone || '',
                    d.category_type || 'CAP_CUU_Y_TE',
                    d.address || '',
                    Boolean(d.has_gps),
                    d.latitude,
                    d.longitude,
                    d.parent_id || d.parent_device_id || '',
                    d.group_name || '',
                    d.heartbeat_interval || 300
                );
            } else {
                openAssignDeviceModal(deviceId, '', '', '', '', 'CAP_CUU_Y_TE', '', false, null, null, '', '', 300);
            }
        })
        .catch(err => {
            console.error("Lỗi khi tải thông tin thiết bị:", err);
            openAssignDeviceModal(deviceId, '', '', '', '', 'CAP_CUU_Y_TE', '', false, null, null, '', '', 300);
        });
}
window.triggerAssignModal = triggerAssignModal;

window.openAssignDeviceModal = openAssignDeviceModal;
window.closeAssignDeviceModal = closeAssignDeviceModal;
window.submitAssignDevice = submitAssignDevice;
window.zoomToDeviceOnMap = zoomToDeviceOnMap;
window.handleDeviceRowClick = handleDeviceRowClick;


// ================= QUẢN LÝ TẠO THIẾT BỊ THEO CHUẨN HC TECH IOT PLATFORM =================
let hctechGroupsList = [];
let hctechPackagesList = [];

async function loadHCTechGroupsAndPackages() {
    const groupSelect = document.getElementById('reg-group-id');
    const pkgSelect = document.getElementById('reg-package-version-id');
    if (!groupSelect || !pkgSelect) return;

    groupSelect.innerHTML = '<option value="">⏳ Đang nạp danh sách nhóm từ IoT Platform...</option>';
    pkgSelect.innerHTML = '<option value="">-- Vui lòng chọn Nhóm thiết bị trước --</option>';

    try {
        const [resG, resP] = await Promise.all([
            fetch('/api/hctech/groups/'),
            fetch('/api/hctech/packages/')
        ]);
        const dataG = await resG.json();
        const dataP = await resP.json();

        hctechGroupsList = dataG.data || [];
        hctechPackagesList = dataP.data || [];

        // Render danh sách groups
        groupSelect.innerHTML = '<option value="">-- Chọn Nhóm thiết bị (Group) --</option>';
        if (hctechGroupsList.length === 0) {
            groupSelect.innerHTML += '<option value="" disabled>Không có nhóm nào khả dụng</option>';
        } else {
            hctechGroupsList.forEach(g => {
                const typeBadge = (g.type || 'lorawan').toUpperCase();
                const opt = document.createElement('option');
                opt.value = g.id;
                opt.dataset.type = (g.type || 'lorawan').toLowerCase();
                opt.dataset.name = g.name || '';
                opt.innerText = `[${typeBadge}] ${g.name || 'Nhóm ' + g.id} (${g.device_count || 0} thiết bị)`;
                groupSelect.appendChild(opt);
            });
        }

        // Tự động chọn nhóm đầu tiên nếu có
        if (hctechGroupsList.length > 0) {
            groupSelect.selectedIndex = 1;
            handleHCTechGroupChange();
        }
    } catch (err) {
        console.error("Lỗi khi tải groups hoặc packages:", err);
        groupSelect.innerHTML = '<option value="">❌ Lỗi kết nối IoT Platform</option>';
    }
}

function handleHCTechGroupChange() {
    const groupSelect = document.getElementById('reg-group-id');
    const pkgSelect = document.getElementById('reg-package-version-id');
    const groupTypeBadge = document.getElementById('reg-group-type-badge');
    if (!groupSelect || !pkgSelect) return;

    const selectedOpt = groupSelect.options[groupSelect.selectedIndex];
    const groupType = selectedOpt?.dataset?.type || '';

    if (groupTypeBadge) {
        if (groupType) {
            groupTypeBadge.classList.remove('hidden');
            groupTypeBadge.innerText = groupType.toUpperCase();
            if (groupType === 'lorawan') {
                groupTypeBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30';
            } else if (groupType === 'http') {
                groupTypeBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30';
            } else {
                groupTypeBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
            }
        } else {
            groupTypeBadge.classList.add('hidden');
        }
    }

    if (!groupSelect.value) {
        pkgSelect.innerHTML = '<option value="">-- Vui lòng chọn Nhóm thiết bị trước --</option>';
        return;
    }

    // Lọc packages tương thích với nhóm đã chọn
    const filteredPackages = hctechPackagesList.filter(p => {
        if (!p.connection_type && !p.type) return true;
        const pType = (p.connection_type || p.type || '').toLowerCase();
        return pType === groupType || !groupType;
    });

    pkgSelect.innerHTML = '<option value="">-- Chọn Device Profile phù hợp --</option>';
    const listToRender = filteredPackages.length > 0 ? filteredPackages : hctechPackagesList;

    listToRender.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.package_version_id || p.id;
        opt.dataset.hasGps = p.has_gps ? 'true' : 'false';
        opt.dataset.deviceType = p.device_type || 'NUT_NHAN';
        opt.dataset.desc = p.description || '';
        opt.dataset.uplinkInterval = p.uplink_interval || p.heartbeat_interval || 300;
        opt.dataset.deviceClass = p.device_class || 'A';
        opt.dataset.supportsOtaa = (p.supports_otaa !== false) ? 'true' : 'false';
        if (p.name) {
            opt.innerText = p.name;
        } else {
            const verText = p.version ? ` (v${p.version})` : '';
            const profName = p.device_profile ? ` • ${p.device_profile}` : '';
            opt.innerText = `${p.model || p.code || 'Gói cấu hình'}${profName}${verText}`;
        }
        pkgSelect.appendChild(opt);
    });

    if (pkgSelect.options.length > 1) {
        pkgSelect.selectedIndex = 1;
        handleHCTechPackageChange();
    }
}

function handleHCTechPackageChange() {
    const pkgSelect = document.getElementById('reg-package-version-id');
    const descEl = document.getElementById('reg-package-desc');
    const gpsSelect = document.getElementById('reg-has-gps');
    const deviceTypeSelect = document.getElementById('reg-device-type');
    const specHb = document.getElementById('reg-spec-heartbeat');
    const specClass = document.getElementById('reg-spec-class');
    const specOtaa = document.getElementById('reg-spec-otaa');
    const hiddenHb = document.getElementById('reg-heartbeat-interval');
    if (!pkgSelect) return;

    const selectedOpt = pkgSelect.options[pkgSelect.selectedIndex];
    if (!selectedOpt || !selectedOpt.value) return;

    const desc = selectedOpt.dataset?.desc;
    if (descEl) {
        if (desc) {
            descEl.innerText = desc;
            descEl.classList.remove('hidden');
        } else {
            descEl.innerText = "Thông số kết nối và chu kỳ heartbeat được tự động gán từ gói cấu hình.";
        }
    }

    // Tự động nhận diện chu kỳ gửi tin Heartbeat (uplink_interval), Class và OTAA từ package
    const uplinkSec = parseInt(selectedOpt.dataset?.uplinkInterval) || 300;
    const devClass = selectedOpt.dataset?.deviceClass || 'A';
    const isOtaa = selectedOpt.dataset?.supportsOtaa !== 'false';

    if (specHb) specHb.innerText = `${uplinkSec}s`;
    if (specClass) specClass.innerText = devClass;
    if (specOtaa) specOtaa.innerText = isOtaa ? 'OTAA' : 'Khác';
    if (hiddenHb) hiddenHb.value = uplinkSec;

    // Tự động nhận diện GPS và Device Type nếu Profile có định dạng tương ứng
    if (selectedOpt.dataset?.hasGps === 'true' && gpsSelect) {
        gpsSelect.value = 'true';
        if (typeof toggleStaticAddressField === 'function') toggleStaticAddressField();
    }
    if (selectedOpt.dataset?.deviceType && deviceTypeSelect) {
        if (selectedOpt.dataset.deviceType === 'CAMERA') {
            deviceTypeSelect.value = 'CAMERA';
        } else if (selectedOpt.dataset.deviceType === 'GATEWAY') {
            deviceTypeSelect.value = 'GATEWAY';
        } else {
            deviceTypeSelect.value = 'NUT_NHAN';
        }
    }
}

function showRegStatus(msg, type) {
    const statusMsg = document.getElementById('reg-device-status-msg');
    if (!statusMsg) {
        alert(msg);
        return;
    }
    statusMsg.classList.remove(
        'hidden',
        'bg-rose-50', 'text-rose-700', 'border-rose-200', 'dark:bg-rose-950/40', 'dark:text-rose-300', 'dark:border-rose-800',
        'bg-emerald-50', 'text-emerald-700', 'border-emerald-200', 'dark:bg-emerald-950/40', 'dark:text-emerald-300', 'dark:border-emerald-800',
        'bg-sky-50', 'text-sky-700', 'border-sky-200', 'dark:bg-sky-950/40', 'dark:text-sky-300', 'dark:border-sky-800',
        'bg-rose-500/20', 'text-rose-400', 'border-rose-500/40',
        'bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/40',
        'bg-cyan-500/20', 'text-cyan-400', 'border-cyan-500/40'
    );
    if (type === 'error') {
        statusMsg.classList.add('bg-rose-50', 'text-rose-700', 'border', 'border-rose-200', 'dark:bg-rose-950/40', 'dark:text-rose-300', 'dark:border-rose-800');
    } else if (type === 'success') {
        statusMsg.classList.add('bg-emerald-50', 'text-emerald-700', 'border', 'border-emerald-200', 'dark:bg-emerald-950/40', 'dark:text-emerald-300', 'dark:border-emerald-800');
    } else {
        statusMsg.classList.add('bg-sky-50', 'text-sky-700', 'border', 'border-sky-200', 'dark:bg-sky-950/40', 'dark:text-sky-300', 'dark:border-sky-800');
    }
    statusMsg.innerHTML = msg;
}

async function submitNewDevice() {
    const btnSubmit = document.getElementById('reg-btn-submit');

    // 1. Lấy thông tin cơ bản, chủ sở hữu, vị trí
    const name = document.getElementById('reg-name')?.value?.trim();
    const customer_name = document.getElementById('reg-owner')?.value?.trim();
    const emergency_phone = document.getElementById('reg-phone')?.value?.trim();
    const address = document.getElementById('reg-address')?.value?.trim();
    const latitude = parseFloat(document.getElementById('reg-lat')?.value) || 16.054407;
    const longitude = parseFloat(document.getElementById('reg-lng')?.value) || 108.202167;

    // 2. Nhóm thiết bị (group_id) & Device Profile (package_version_id)
    const group_id = document.getElementById('reg-group-id')?.value;
    const package_version_id = document.getElementById('reg-package-version-id')?.value;

    // 3. Phương thức kích hoạt (OTAA) & DevEUI, AppKey
    const dev_eui = document.getElementById('reg-deveui')?.value?.trim().toUpperCase();
    const app_key = document.getElementById('reg-appkey')?.value?.trim();
    const activation_type = document.getElementById('reg-activation-type')?.value || 'OTAA';

    // 4. Các thông tin bổ sung
    let device_type = document.getElementById('reg-device-type')?.value || 'NUT_NHAN';
    if (name && (name.toLowerCase().includes('nút') || name.toLowerCase().includes('nut'))) {
        device_type = 'NUT_NHAN';
    }
    const category_type = document.getElementById('reg-category-type')?.value || 'CAP_CUU_Y_TE';
    const has_gps = document.getElementById('reg-has-gps')?.value === 'true';
    const parentIdVal = document.getElementById('reg-parent-id')?.value;
    const parent_device_id = parentIdVal ? parseInt(parentIdVal) : null;
    const group_name = document.getElementById('reg-group-name')?.value?.trim() || '';
    const heartbeat_interval = parseInt(document.getElementById('reg-heartbeat-interval')?.value) || 300;

    // Validation các trường bắt buộc
    if (!name) {
        showRegStatus("Vui lòng nhập Tên thiết bị!", "error");
        document.getElementById('reg-name')?.focus();
        return;
    }
    if (!customer_name) {
        showRegStatus("Vui lòng nhập Tên chủ sở hữu / Đơn vị quản lý!", "error");
        document.getElementById('reg-owner')?.focus();
        return;
    }
    if (!emergency_phone) {
        showRegStatus("Vui lòng nhập Số điện thoại liên hệ khẩn cấp!", "error");
        document.getElementById('reg-phone')?.focus();
        return;
    }
    if (!group_id) {
        showRegStatus("Vui lòng chọn Nhóm thiết bị (Group)!", "error");
        document.getElementById('reg-group-id')?.focus();
        return;
    }
    if (!package_version_id) {
        showRegStatus("Vui lòng chọn Device Profile (Package Version)! ", "error");
        document.getElementById('reg-package-version-id')?.focus();
        return;
    }
    if (!dev_eui || dev_eui.length < 8) {
        showRegStatus("Vui lòng nhập DevEUI hợp lệ (16 ký tự Hex, vd: CF8B03FFFF6430C5)!", "error");
        document.getElementById('reg-deveui')?.focus();
        return;
    }
    if (!app_key || app_key.length < 16) {
        showRegStatus("Vui lòng nhập AppKey hợp lệ (32 ký tự Hex) cho phương thức kích hoạt OTAA!", "error");
        document.getElementById('reg-appkey')?.focus();
        return;
    }

    // Chuẩn bị body payload theo đúng hợp đồng HC TECH IoT Platform:
    // {
    //   "group_id": "...",
    //   "package_version_id": "...",
    //   "dev_eui": "...",
    //   "name": "...",
    //   "activation": {
    //     "app_key": "..."
    //   }
    // }
    const payload = {
        name: name,
        customer_name: customer_name,
        emergency_phone: emergency_phone,
        address: address,
        latitude: latitude,
        longitude: longitude,
        group_id: group_id,
        package_version_id: package_version_id,
        dev_eui: dev_eui,
        activation: {
            app_key: app_key
        },
        app_key: app_key,
        activation_type: activation_type,
        device_type: device_type,
        category_type: category_type,
        has_gps: has_gps,
        parent_device_id: parent_device_id,
        group_name: group_name,
        heartbeat_interval: heartbeat_interval
    };

    if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Đang gọi API POST /devices...';
    }
    showRegStatus('<i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang gửi yêu cầu tạo thiết bị tới HC TECH IoT Cloud (POST /devices)...', 'info');

    try {
        const res = await fetch('/api/devices/register/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await res.json();

        // Dựa vào status code để xác định đã tạo thành công chưa
        if (res.ok && result.status === 'success') {
            const codeInfo = result.iot_status_code ? ` (Mã HTTP: ${result.iot_status_code})` : '';
            showRegStatus(`✅ ${result.message || 'Tạo thiết bị thành công!'}`, 'success');
            setTimeout(() => {
                sessionStorage.setItem('active_hc_tab', 'devices');
                location.reload();
            }, 1200);
        } else {
            const codeInfo = result.iot_status_code ? ` (Mã HTTP: ${result.iot_status_code})` : ` (Mã HTTP: ${res.status})`;
            showRegStatus(`❌ Lỗi tạo thiết bị${codeInfo}: ${result.message || 'IoT Platform từ chối yêu cầu.'}`, 'error');
        }
    } catch (err) {
        showRegStatus(`❌ Lỗi kết nối mạng: ${err.message}`, 'error');
    } finally {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = '<i class="fa-solid fa-cloud-arrow-up mr-1.5"></i> Tạo & Kích Hoạt Thiết Bị (POST /devices)';
        }
    }
}

window.loadHCTechGroupsAndPackages = loadHCTechGroupsAndPackages;
window.handleHCTechGroupChange = handleHCTechGroupChange;
window.handleHCTechPackageChange = handleHCTechPackageChange;
window.submitNewDevice = submitNewDevice;
window.openAddDeviceModal = openAddDeviceModal;
window.closeAddDeviceModal = closeAddDeviceModal;
window.initRegMiniMap = initRegMiniMap;
window.setRegCoords = setRegCoords;
window.centerRegMiniMap = centerRegMiniMap;
window.onRegAddressInput = onRegAddressInput;
window.onRegAddressFocus = onRegAddressFocus;
window.clearRegAddress = clearRegAddress;
window.selectRegAddress = selectRegAddress;
window.onRegAddressKeyDown = onRegAddressKeyDown;



// ================= MODAL GÁN THIẾT BỊ VỚI NHAU (CÙNG NHÀ / NHÓM) =================
function openQuickPairModal(deviceId, deviceName, parentId, groupName) {
    const modal = document.getElementById('quick-pair-modal');
    if (!modal) return;

    const idInput = document.getElementById('quick-pair-dev-id');
    const nameEl = document.getElementById('quick-pair-dev-name');
    const parentSelect = document.getElementById('quick-pair-parent-id') || document.getElementById('quick-pair-gps-id');
    const groupInput = document.getElementById('quick-pair-group-name');

    if (idInput) idInput.value = deviceId || '';
    if (nameEl) nameEl.innerText = deviceName || ('Thiết bị #' + deviceId);

    if (parentSelect) {
        parentSelect.value = parentId || '';
        // Ẩn / vô hiệu hóa chính thiết bị đang chọn để không tự gán vào chính nó
        Array.from(parentSelect.options).forEach(opt => {
            if (opt.value && String(opt.value) === String(deviceId)) {
                opt.style.display = 'none';
                opt.disabled = true;
            } else {
                opt.style.display = '';
                opt.disabled = false;
            }
        });
    }

    if (groupInput) groupInput.value = groupName || '';

    modal.classList.remove('hidden');
}

function handleQuickPairParentChange() {
    const parentSelect = document.getElementById('quick-pair-parent-id') || document.getElementById('quick-pair-gps-id');
    const groupInput = document.getElementById('quick-pair-group-name');
    if (!parentSelect || !groupInput) return;

    const selectedOpt = parentSelect.options[parentSelect.selectedIndex];
    if (selectedOpt && selectedOpt.dataset) {
        // Tự động gợi ý tên nhóm nếu ô nhập đang trống
        if (!groupInput.value.trim() && selectedOpt.dataset.group) {
            groupInput.value = selectedOpt.dataset.group;
        } else if (!groupInput.value.trim() && selectedOpt.dataset.owner) {
            groupInput.value = 'Nhà ' + selectedOpt.dataset.owner;
        }
    }
}

function closeQuickPairModal() {
    const modal = document.getElementById('quick-pair-modal');
    if (modal) modal.classList.add('hidden');
}

async function submitQuickPair(e) {
    if (e) e.preventDefault();
    const devId = document.getElementById('quick-pair-dev-id')?.value;
    if (!devId) return alert("Không tìm thấy ID thiết bị!");

    const parentSelect = document.getElementById('quick-pair-parent-id') || document.getElementById('quick-pair-gps-id');
    const parentId = parentSelect?.value;
    const groupName = document.getElementById('quick-pair-group-name')?.value?.trim();
    const syncInfo = document.getElementById('quick-pair-sync-info')?.checked || false;

    const btn = document.getElementById('btn-save-quick-pair');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;
    }

    try {
        const res = await fetch(`/api/devices/${devId}/pair/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                parent_device_id: parentId || null,
                group_name: groupName || '',
                sync_info: syncInfo
            })
        });
        const result = await res.json();
        if (res.ok && result.status === 'success') {
            closeQuickPairModal();
            alert("✅ " + (result.message || "Đã lưu liên kết nhóm thành công!"));
            sessionStorage.setItem('active_hc_tab', 'devices');
            location.reload();
        } else {
            alert("❌ " + (result.message || "Không thể lưu liên kết nhóm!"));
        }
    } catch (err) {
        alert("❌ Lỗi kết nối khi gán nhóm: " + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-check"></i> <span>Lưu Liên Kết</span>`;
        }
    }
}

window.openQuickPairModal = openQuickPairModal;
window.handleQuickPairParentChange = handleQuickPairParentChange;
window.closeQuickPairModal = closeQuickPairModal;
window.submitQuickPair = submitQuickPair;

function filterDeviceTable() {
    const q = (document.getElementById('dev-search-input')?.value || '').toLowerCase();
    const t = document.getElementById('dev-type-filter')?.value || '';
    const c = document.getElementById('dev-conn-filter')?.value || '';
    const g = document.getElementById('dev-gps-filter')?.value || '';
    const grp = document.getElementById('dev-group-filter')?.value || '';

    document.querySelectorAll('.device-row').forEach(row => {
        const textMatch = row.innerText.toLowerCase().includes(q);
        const typeMatch = !t || row.dataset.type === t;
        const connMatch = !c || row.dataset.conn === c;
        const gpsMatch = !g || row.dataset.gps === g;

        let grpMatch = true;
        if (grp === 'PAIRED') {
            grpMatch = (row.dataset.hasParent === 'true' || (row.dataset.subCount && parseInt(row.dataset.subCount) > 0) || (row.dataset.group && row.dataset.group.trim() !== ''));
        } else if (grp === 'UNPAIRED') {
            grpMatch = (row.dataset.hasParent !== 'true' && (!row.dataset.subCount || parseInt(row.dataset.subCount) === 0) && (!row.dataset.group || row.dataset.group.trim() === ''));
        }

        row.style.display = (textMatch && typeMatch && connMatch && gpsMatch && grpMatch) ? '' : 'none';
    });
}

function toggleAllDeviceChecks(master) {
    document.querySelectorAll('.dev-check').forEach(cb => cb.checked = master.checked);
}

async function deleteSelectedDevices() {
    const ids = Array.from(document.querySelectorAll('.dev-check:checked')).map(cb => parseInt(cb.value));
    if (ids.length === 0) return alert("Vui lòng tích chọn ít nhất 1 thiết bị để xóa!");
    if (!confirm(`Bạn có chắc chắn muốn xóa ${ids.length} thiết bị đã chọn?`)) return;

    const res = await fetch('/api/devices/delete/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
    });
    if (res.ok) {
        sessionStorage.setItem('active_hc_tab', 'devices');
        location.reload();
    }
}

// ================= 5. PHÁT THÔNG BÁO KHẨN CẤP THỦ CÔNG & ĐIỀU KHIỂN NÚT KHẨN CẤP =================
function setEmergencyButtonState(isAlerting, deviceId = null) {
    const btn = document.getElementById('btn-header-emergency');
    if (!btn) return;

    if (isAlerting) {
        btn.setAttribute('data-state', 'alerting');
        if (deviceId) {
            btn.setAttribute('data-device-id', deviceId);
        }
        btn.className = "hc-header-pill bg-amber-600 hover:bg-amber-500 text-white font-bold shadow-md animate-pulse transition";
        btn.innerHTML = '<i id="icon-header-emergency" class="fa-solid fa-bell-slash mr-1.5"></i><span id="text-header-emergency">Tắt cảnh báo</span>';
        btn.title = "Đang có cảnh báo khẩn cấp - Bấm để tắt cảnh báo";
    } else {
        btn.setAttribute('data-state', 'idle');
        btn.removeAttribute('data-device-id');
        btn.className = "hc-header-pill bg-red-600 hover:bg-red-500 text-white font-bold shadow-md transition";
        btn.innerHTML = '<i id="icon-header-emergency" class="fa-solid fa-bolt mr-1.5"></i><span id="text-header-emergency">Gửi thông báo khẩn</span>';
        btn.title = "Bấm để phát cảnh báo khẩn cấp thủ công";
    }
}
window.setEmergencyButtonState = setEmergencyButtonState;

async function handleHeaderEmergencyAction() {
    const btn = document.getElementById('btn-header-emergency');
    const state = btn?.getAttribute('data-state') || 'idle';

    if (state === 'alerting') {
        // Đang ở trạng thái phát cảnh báo khẩn -> bấm nút này để TẮT CẢNH BÁO
        const devId = btn.getAttribute('data-device-id') || currentEmergencyDeviceId;
        await turnOffActiveEmergency(devId);
    } else {
        // Trạng thái bình thường -> mở modal phát cảnh báo khẩn cấp
        openManualSOSModal();
    }
}
window.handleHeaderEmergencyAction = handleHeaderEmergencyAction;

async function turnOffActiveEmergency(deviceId = null) {
    // Dừng ngay còi báo động để lập tức giảm ồn
    stopSiren();

    const btn = document.getElementById('btn-header-emergency');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Đang tắt...';
    }

    try {
        const targetId = deviceId || currentEmergencyDeviceId;
        const res = await fetch('/api/alerts/turn_off_emergency/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: targetId })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            currentAlertId = null;
            currentEmergencyDeviceId = null;
            currentEmergencyCoords = null;

            const emergencyModal = document.getElementById('emergency-modal');
            if (emergencyModal) emergencyModal.classList.add('hidden');
            if (typeof map !== 'undefined' && map) map.closePopup();

            setEmergencyButtonState(false);
            refreshMapMarkers();
        } else {
            alert("❌ Lỗi: " + (data.message || "Không thể tắt cảnh báo"));
            setEmergencyButtonState(true, deviceId);
        }
    } catch (err) {
        console.error("Lỗi khi tắt cảnh báo khẩn cấp:", err);
        alert("❌ Lỗi kết nối khi gửi yêu cầu tắt cảnh báo!");
        setEmergencyButtonState(true, deviceId);
    } finally {
        if (btn) btn.disabled = false;
    }
}
window.turnOffActiveEmergency = turnOffActiveEmergency;

function openManualSOSModal() {
    const modal = document.getElementById('manual-dispatch-modal');
    if (!modal) return;

    // Cập nhật thẻ xem trước thông tin thiết bị đang chọn
    updateSelectedDevicePreview();

    // Mặc định không tích chọn ghi chú
    const notesToggle = document.getElementById('manual-sos-has-notes');
    const notesWrapper = document.getElementById('manual-sos-notes-wrapper');
    const notesInput = document.getElementById('manual-sos-notes');
    if (notesToggle) notesToggle.checked = false;
    if (notesWrapper) notesWrapper.classList.add('hidden');
    if (notesInput) notesInput.value = '';

    modal.classList.remove('hidden');
}

function closeManualSOSModal() {
    const modal = document.getElementById('manual-dispatch-modal');
    if (modal) modal.classList.add('hidden');
}

function toggleManualSOSNotes() {
    const isChecked = document.getElementById('manual-sos-has-notes')?.checked;
    const notesWrapper = document.getElementById('manual-sos-notes-wrapper');
    const notesInput = document.getElementById('manual-sos-notes');
    if (notesWrapper) {
        if (isChecked) {
            notesWrapper.classList.remove('hidden');
            if (notesInput) notesInput.focus();
        } else {
            notesWrapper.classList.add('hidden');
        }
    }
}

function updateSelectedDevicePreview() {
    const select = document.getElementById('manual-sos-device');
    if (!select || !select.options || select.selectedIndex < 0) return;

    const opt = select.options[select.selectedIndex];
    if (!opt) return;

    const owner = opt.getAttribute('data-owner') || 'Chưa rõ chủ';
    const phone = opt.getAttribute('data-phone') || '-';
    const hasGps = opt.getAttribute('data-gps') === 'true';
    const lat = opt.getAttribute('data-lat');
    const lng = opt.getAttribute('data-lng');
    const address = opt.getAttribute('data-address');
    const status = opt.getAttribute('data-status') || 'ONLINE';

    const ownerEl = document.getElementById('preview-device-owner');
    const locEl = document.getElementById('preview-device-location');
    const statusEl = document.getElementById('preview-device-status');

    if (ownerEl) ownerEl.innerText = `${owner} (${phone})`;
    if (locEl) {
        locEl.innerText = hasGps ? `GPS: ${lat}, ${lng}` : (address || 'Đất liền');
    }
    if (statusEl) {
        if (status === 'SOS') {
            statusEl.innerHTML = '<span class="px-2 py-0.5 rounded-md bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-400 font-bold">Đang phát SOS</span>';
        } else if (status === 'PROCESSING') {
            statusEl.innerHTML = '<span class="px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 font-bold">Đang xử lý</span>';
        } else if (status === 'OFFLINE') {
            statusEl.innerHTML = '<span class="px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-bold">Offline</span>';
        } else {
            statusEl.innerHTML = '<span class="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 font-bold">Bình thường (Online)</span>';
        }
    }
}

async function submitManualSOS() {
    const select = document.getElementById('manual-sos-device');
    if (!select || !select.value) {
        alert("Vui lòng chọn thiết bị tiếp nhận cảnh báo khẩn cấp!");
        return;
    }

    const deviceId = select.value;
    const alertType = document.getElementById('manual-sos-type')?.value || 'CUU_HO_BIEN';
    const hasNotes = document.getElementById('manual-sos-has-notes')?.checked;
    const notes = hasNotes ? (document.getElementById('manual-sos-notes')?.value || '').trim() : '';

    const btn = document.getElementById('btn-submit-manual-sos');
    const originalContent = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Đang phát cảnh báo...';
    }

    try {
        const res = await fetch('/api/alerts/dispatch/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                alert_type: alertType,
                notes: notes
            })
        });

        const data = await res.json();
        if (res.ok && data.status === 'success') {
            closeManualSOSModal();
            currentEmergencyDeviceId = data.device_id;
            if (data.latitude && data.longitude) {
                currentEmergencyCoords = [data.latitude, data.longitude];
            }
            // Chuyển nút bấm trên header sang trạng thái "Tắt cảnh báo"
            setEmergencyButtonState(true, data.device_id);
            // Tự động chuyển qua tab Bản đồ và zoom tới vị trí thiết bị
            showMapTab(true);
            if (data.latitude && data.longitude && typeof map !== 'undefined' && map) {
                map.flyTo([data.latitude, data.longitude], 15, { animate: true, duration: 1.2 });
            }
            refreshMapMarkers();
        } else {
            alert("❌ Lỗi: " + (data.message || "Không thể phát cảnh báo khẩn cấp!"));
        }
    } catch (err) {
        console.error("Lỗi khi gửi cảnh báo khẩn cấp:", err);
        alert("❌ Lỗi kết nối đến máy chủ khi gửi cảnh báo!");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

function simulateSOS() {
    openManualSOSModal();
}

function switchTab(tab) {
    if (tab === 'map') {
        // 🔄 KHI CHUYỂN TỪ TRANG HÀNH TRÌNH VỀ TRANG CHỦ BẢN ĐỒ: RELOAD / RESET LẠI BẢN ĐỒ
        if (playTimer) {
            clearInterval(playTimer);
            playTimer = null;
        }
        routeLayer.clearLayers();
        routePoints = [];
        playIndex = 0;
        movingMarker = null;

        const slider = document.getElementById('route-slider');
        if (slider) {
            slider.max = 100;
            slider.value = 0;
        }
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        const distEl = document.getElementById('route-distance');
        if (distEl) distEl.innerText = '0.0 km';
        const speedEl = document.getElementById('route-speed');
        if (speedEl) speedEl.innerText = '0 km/h';
        const timeEl = document.getElementById('route-current-time');
        if (timeEl) timeEl.innerText = 'Chưa tải hành trình';
        const stepEl = document.getElementById('route-step-indicator');
        if (stepEl) stepEl.innerText = 'Điểm: 0 / 0';
        const statusEl = document.getElementById('route-point-status');
        if (statusEl) statusEl.innerHTML = '';

        showMapTab(false);
        refreshMapMarkers(true);
    } else if (tab === 'playback') {
        const allSections = ['map', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
        allSections.forEach(s => {
            const el = document.getElementById(`section-${s}`);
            if (el) el.classList.add('hidden');
        });

        const allBtns = ['map', 'playback', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
        allBtns.forEach(b => {
            const btn = document.getElementById(`tab-btn-${b}`);
            if (btn) btn.classList.remove('hc-nav-active');
        });

        const activeBtn = document.getElementById(`tab-btn-${tab}`);
        if (activeBtn) activeBtn.classList.add('hc-nav-active');

        document.getElementById('section-map')?.classList.remove('hidden');
        const pbToolbar = document.getElementById('playback-toolbar');
        if (pbToolbar) pbToolbar.classList.remove('hidden');
        const pbPlayer = document.getElementById('playback-player-bar');
        if (pbPlayer) pbPlayer.classList.remove('hidden');
        const filterBox = document.getElementById('map-filter-box');
        if (filterBox) filterBox.classList.add('hidden');
        setTimeout(() => map.invalidateSize(), 150);
    } else {
        const allSections = ['map', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
        allSections.forEach(s => {
            const el = document.getElementById(`section-${s}`);
            if (el) el.classList.add('hidden');
        });

        const allBtns = ['map', 'playback', 'stats', 'devices', 'alerts', 'accounts', 'settings'];
        allBtns.forEach(b => {
            const btn = document.getElementById(`tab-btn-${b}`);
            if (btn) btn.classList.remove('hc-nav-active');
        });

        const activeBtn = document.getElementById(`tab-btn-${tab}`);
        if (activeBtn) activeBtn.classList.add('hc-nav-active');

        const pbToolbar = document.getElementById('playback-toolbar');
        if (pbToolbar) pbToolbar.classList.add('hidden');
        const pbPlayer = document.getElementById('playback-player-bar');
        if (pbPlayer) pbPlayer.classList.add('hidden');

        const target = document.getElementById(`section-${tab}`);
        if (target) target.classList.remove('hidden');
        if (tab === 'stats') {
            loadStatsData();
        } else if (tab === 'alerts') {
            refreshMapMarkers();
        }
    }

    // Đồng bộ trạng thái active cho thanh điều hướng di động (Mobile Bottom Nav) & đóng drawer
    try {
        document.querySelectorAll('.hc-mobile-nav-item').forEach(b => b.classList.remove('active'));
        const mobileBtn = document.getElementById(`mobile-nav-btn-${tab}`);
        if (mobileBtn) mobileBtn.classList.add('active');
        if (typeof closeMobileSidebar === 'function') {
            closeMobileSidebar();
        }
    } catch (e) {
        // Bỏ qua nếu chưa load DOM mobile
    }
}

function initStatsChart() {
    const canvas = document.getElementById('deviceDonutChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const online = parseInt(canvas.dataset.online) || 1;
    const offline = parseInt(canvas.dataset.offline) || 0;
    const maint = parseInt(canvas.dataset.maint) || 0;

    new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: ['Đang kết nối', 'Mất kết nối', 'Đang bảo trì'],
            datasets: [{
                data: [online, offline, maint],
                backgroundColor: ['#3b82f6', '#ef4444', '#f59e0b'],
                borderWidth: 0
            }]
        },
        options: {
            cutout: '72%',
            plugins: { legend: { display: false } }
        }
    });
}

// ================= 7. XỬ LÝ DỮ LIỆU & BỘ LỌC MỤC THỐNG KÊ =================
let currentStatsRange = '12m';
let currentStatsType = '';

async function loadStatsData() {
    try {
        const url = `/api/stats/?range=${encodeURIComponent(currentStatsRange)}&alert_type=${encodeURIComponent(currentStatsType)}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        // 1. Cập nhật số liệu Tổng cộng
        const elChay = document.getElementById('stat-count-chay');
        const elYte = document.getElementById('stat-count-yte');
        const elAnNinh = document.getElementById('stat-count-anninh');
        if (elChay) elChay.innerText = data.chay_count;
        if (elYte) elYte.innerText = data.yte_count;
        if (elAnNinh) elAnNinh.innerText = data.anninh_count;

        // 2. Cập nhật số lượng các vụ theo trạng thái
        const elNew = document.getElementById('stat-alert-new');
        const elProc = document.getElementById('stat-alert-proc');
        const elRes = document.getElementById('stat-alert-res');
        const elFalse = document.getElementById('stat-alert-false');

        if (elNew) elNew.innerText = `${data.alert_new} vụ`;
        if (elProc) elProc.innerText = `${data.alert_proc} vụ`;
        if (elRes) elRes.innerText = `${data.alert_res} vụ`;
        if (elFalse) elFalse.innerText = `${data.alert_false} vụ`;

        // 3. Cập nhật chiều rộng thanh tiến trình
        const barNew = document.getElementById('stat-bar-new');
        const barProc = document.getElementById('stat-bar-proc');
        const barRes = document.getElementById('stat-bar-res');
        const barFalse = document.getElementById('stat-bar-false');

        if (barNew) barNew.style.width = `${data.pct_new}%`;
        if (barProc) barProc.style.width = `${data.pct_proc}%`;
        if (barRes) barRes.style.width = `${data.pct_res}%`;
        if (barFalse) barFalse.style.width = `${data.pct_false}%`;
    } catch (err) {
        console.error("Lỗi khi tải dữ liệu thống kê:", err);
    }
}

function selectStatRange(range) {
    currentStatsRange = range;
    const ranges = ['today', '7d', '30d', '3m', '12m'];
    ranges.forEach(r => {
        const btn = document.getElementById(`btn-stat-range-${r}`);
        if (!btn) return;
        if (r === range) {
            btn.className = 'hc-btn-primary px-4 py-2 rounded-full font-bold transition-all';
        } else {
            btn.className = 'hc-input px-3 py-2 rounded-full transition-all';
        }
    });
    loadStatsData();
}

function selectStatType(type) {
    // Nếu click lại vào loại đang chọn thì quay về hiển thị tất cả
    if (currentStatsType === type) {
        currentStatsType = '';
    } else {
        currentStatsType = type;
    }

    const btnAll = document.getElementById('btn-stat-type-all');
    const btnChay = document.getElementById('btn-stat-type-CHAY');
    const btnYte = document.getElementById('btn-stat-type-CAP_CUU_Y_TE');
    const btnAnNinh = document.getElementById('btn-stat-type-AN_NINH');

    if (btnAll) btnAll.className = (currentStatsType === '')
        ? 'hc-btn-primary px-3 py-1.5 rounded-lg font-bold transition-all'
        : 'hc-input px-3 py-1.5 rounded-lg font-medium transition-all';

    if (btnChay) btnChay.className = (currentStatsType === 'CHAY')
        ? 'bg-red-600 text-white font-bold px-3 py-1.5 rounded-lg shadow-md transition-all'
        : 'hc-input px-3 py-1.5 rounded-lg font-medium transition-all';

    if (btnYte) btnYte.className = (currentStatsType === 'CAP_CUU_Y_TE')
        ? 'bg-emerald-600 text-white font-bold px-3 py-1.5 rounded-lg shadow-md transition-all'
        : 'hc-input px-3 py-1.5 rounded-lg font-medium transition-all';

    if (btnAnNinh) btnAnNinh.className = (currentStatsType === 'AN_NINH')
        ? 'bg-amber-600 text-white font-bold px-3 py-1.5 rounded-lg shadow-md transition-all'
        : 'hc-input px-3 py-1.5 rounded-lg font-medium transition-all';

    loadStatsData();
}

window.loadStatsData = loadStatsData;
window.selectStatRange = selectStatRange;
window.selectStatType = selectStatType;

function applyTheme(theme) {
    const body = document.body;
    const html = document.documentElement;
    const icon = document.getElementById('icon-theme');
    const text = document.getElementById('text-theme');
    const btnTheme = document.getElementById('btn-theme-toggle');
    if (theme === 'dark') {
        body.classList.remove('theme-light');
        body.classList.add('theme-dark', 'dark');
        html.classList.add('dark');
        html.classList.remove('light');
        if (icon) icon.className = 'fa-solid fa-sun text-amber-400';
        if (text) text.innerText = 'Nền: TỐI';
        if (btnTheme) btnTheme.title = 'Giao diện: Nền TỐI (Bấm chuyển Sáng)';
    } else {
        body.classList.remove('theme-dark', 'dark');
        html.classList.remove('dark');
        html.classList.add('light');
        body.classList.add('theme-light');
        if (icon) icon.className = 'fa-solid fa-moon text-sky-600';
        if (text) text.innerText = 'Nền: SÁNG';
        if (btnTheme) btnTheme.title = 'Giao diện: Nền SÁNG (Bấm chuyển Tối)';
    }
    localStorage.setItem('hc_dashboard_theme', theme);
}

function toggleTheme() {
    const isDark = document.body.classList.contains('theme-dark') || document.documentElement.classList.contains('dark');
    applyTheme(isDark ? 'light' : 'dark');
}

// ================= 6. REAL-TIME SERVER-SENT EVENTS (SSE) =================
function initSSE() {
    if (!window.EventSource) {
        console.warn("Trình duyệt không hỗ trợ EventSource (SSE), tiếp tục dùng polling");
        return;
    }

    const sse = new EventSource('/api/stream/events/');

    sse.addEventListener('connected', () => {
        console.log("⚡ [SSE] Đã kết nối luồng thời gian thực thành công.");
    });

    sse.addEventListener('message', (e) => {
        try {
            const raw = JSON.parse(e.data);
            const msg = raw.payload || raw;
            console.log("⚡ [SSE] Tín hiệu uplink mới từ thiết bị:", msg);

            if (msg.is_sos && msg.device_id) {
                currentEmergencyDeviceId = msg.device_id;
                if (msg.latitude && msg.longitude) {
                    currentEmergencyCoords = [msg.latitude, msg.longitude];
                }
                setEmergencyButtonState(true, msg.device_id);

                // 🚨 BẬT LOA / CÒI BÁO ĐỘNG NGAY LẬP TỨC (0ms) - BẤM LÀ KÊU NGAY ĐỂ TEST
                startSiren();

                // Cập nhật thông tin và hiển thị Modal khẩn cấp
                currentAlertId = msg.alert_id || currentAlertId;
                const nameEl = document.getElementById('sos-modal-name');
                if (nameEl) nameEl.innerText = msg.device_name || `Thiết bị #${msg.device_id}`;
                const deveuiEl = document.getElementById('sos-modal-deveui');
                if (deveuiEl) deveuiEl.innerText = msg.dev_eui || '';
                const phoneEl = document.getElementById('sos-modal-phone');
                if (phoneEl) phoneEl.innerText = msg.customer_name ? `${msg.customer_name} (${msg.emergency_phone || '-'})` : 'Chưa gán thông tin';
                const locEl = document.getElementById('sos-modal-loc');
                if (locEl) locEl.innerText = `${msg.latitude || '-'}, ${msg.longitude || '-'}`;
                const timeEl = document.getElementById('sos-modal-time');
                if (timeEl) timeEl.innerText = msg.reported_at || new Date().toLocaleTimeString('vi-VN');

                const notesRow = document.getElementById('sos-modal-notes-row');
                const notesEl = document.getElementById('sos-modal-notes');
                const uplinkNotes = (msg.notes || '').trim();
                if (uplinkNotes && !uplinkNotes.includes('Tín hiệu vô tuyến')) {
                    if (notesRow) notesRow.classList.remove('hidden');
                    if (notesEl) notesEl.innerText = uplinkNotes;
                } else {
                    if (notesRow) notesRow.classList.add('hidden');
                    if (notesEl) notesEl.innerText = '';
                }

                const step3 = document.getElementById('step3-box');
                if (step3) step3.classList.remove('hidden');
                const step45 = document.getElementById('step4-5-box');
                if (step45) step45.classList.add('hidden');

                const modal = document.getElementById('emergency-modal');
                if (modal) modal.classList.remove('hidden');

                // Cập nhật số đếm SOS trên Header ngay lập tức
                const sosEl = document.getElementById('stat-sos');
                if (sosEl) {
                    const currentCount = parseInt(sosEl.innerText) || 0;
                    if (currentCount === 0) sosEl.innerText = "1";
                }
            } else if (msg.resolved || msg.is_sos === false) {
                if (currentEmergencyDeviceId === msg.device_id || msg.reset_all) {
                    stopSiren();
                    currentEmergencyDeviceId = null;
                    currentEmergencyCoords = null;
                    currentAlertId = null;
                    setEmergencyButtonState(false);
                }
            }

            // Ngay lập tức cập nhật bản đồ và danh sách thiết bị (0ms delay)
            refreshMapMarkers();
        } catch (err) {
            console.error("Lỗi đọc gói tin SSE:", err);
        }
    });

    sse.onerror = () => {
        console.warn("Mất kết nối SSE, trình duyệt sẽ tự động kết nối lại...");
    };
}

function initDashboard() {
    const savedTheme = localStorage.getItem('hc_dashboard_theme') || 'light';
    applyTheme(savedTheme);
    verifyMapVinaKey();
    initStatsChart();
    refreshMapMarkers(true);
    initSSE();
    setInterval(refreshMapMarkers, 5000);

    // Kích hoạt AudioContext khi người dùng tương tác lần đầu (tuân thủ Browser Autoplay Policy)
    document.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => { });
        }
    }, { once: false, passive: true });

    document.addEventListener('keydown', (e) => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => { });
        }
        if (e.key === 'Escape') {
            closeManualSOSModal();
            closeEmergencyModal();
            if (typeof closeAddDeviceModal === 'function') closeAddDeviceModal();
        }
    });
}

// ================= 7. CẬP NHẬT DANH SÁCH THIẾT BỊ REAL-TIME (0ms KHÔNG CẦN LOAD LẠI TRANG) =================
function updateDeviceTableRealtime(devices) {
    if (!devices || !Array.isArray(devices)) return;
    latestDevicesList = devices;

    const tbody = document.getElementById('device-table-body');
    if (!tbody) return;

    // 1. Cập nhật các thẻ đếm thống kê trên danh sách thiết bị
    let camOnline = 0, camTotal = 0;
    let btnOnline = 0, btnTotal = 0;
    let gwOnline = 0, gwTotal = 0;
    let onlineCount = 0, sosCount = 0, offlineCount = 0;

    devices.forEach(d => {
        const typeRaw = d.device_type_raw || '';
        const isOnline = (d.connection_status === 'ONLINE');
        const isSos = (d.connection_status === 'SOS' || d.connection_status === 'PROCESSING');

        if (isSos) sosCount++;
        else if (isOnline) onlineCount++;
        else offlineCount++;

        if (typeRaw === 'CAMERA') {
            camTotal++;
            if (isOnline || isSos) camOnline++;
        } else if (typeRaw === 'NUT_NHAN') {
            btnTotal++;
            if (isOnline || isSos) btnOnline++;
        } else if (typeRaw === 'GATEWAY') {
            gwTotal++;
            if (isOnline || isSos) gwOnline++;
        }
    });

    // Cập nhật các thẻ Card
    const elCamOn = document.getElementById('devcard-cam-online');
    const elCamTot = document.getElementById('devcard-cam-total');
    const elCamOff = document.getElementById('devcard-cam-offline');
    if (elCamOn) elCamOn.innerText = camOnline;
    if (elCamTot) elCamTot.innerText = camTotal;
    if (elCamOff) elCamOff.innerText = camTotal - camOnline;

    const elBtnOn = document.getElementById('devcard-btn-online');
    const elBtnTot = document.getElementById('devcard-btn-total');
    const elBtnOff = document.getElementById('devcard-btn-offline');
    if (elBtnOn) elBtnOn.innerText = btnOnline;
    if (elBtnTot) elBtnTot.innerText = btnTotal;
    if (elBtnOff) elBtnOff.innerText = btnTotal - btnOnline;

    const elGwOn = document.getElementById('devcard-gw-online');
    const elGwTot = document.getElementById('devcard-gw-total');
    const elGwOff = document.getElementById('devcard-gw-offline');
    if (elGwOn) elGwOn.innerText = gwOnline;
    if (elGwTot) elGwTot.innerText = gwTotal;
    if (elGwOff) elGwOff.innerText = gwTotal - gwOnline;

    const elTotDev = document.getElementById('devcard-total-devices');
    if (elTotDev) elTotDev.innerText = devices.length;

    // Cập nhật Header status pills
    const hOnline = document.getElementById('stat-online');
    const hSos = document.getElementById('stat-sos');
    const hOffline = document.getElementById('stat-offline');
    if (hOnline) hOnline.innerText = onlineCount;
    if (hSos) hSos.innerText = sosCount;
    if (hOffline) hOffline.innerText = offlineCount;

    // 2. Cập nhật các hàng trong bảng thiết bị
    const emptyRow = document.getElementById('empty-device-row');
    if (emptyRow && devices.length > 0) {
        emptyRow.remove();
    }

    devices.forEach(d => {
        let row = tbody.querySelector(`tr[data-id="${d.id}"]`) || tbody.querySelector(`tr[data-deveui="${d.dev_eui}"]`);

        // Format trạng thái
        let statusHtml = '';
        const hbSeconds = d.heartbeat_interval || 60;
        const lastSeenText = d.last_seen || 'Chưa kết nối';
        if (d.connection_status === 'SOS') {
            statusHtml = `
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/50 animate-pulse"><i class="fa-solid fa-triangle-exclamation"></i>Đang phát SOS</span>
                <div class="text-[10px] hc-text-muted mt-1 font-mono flex items-center gap-1" title="Chu kỳ Heartbeat: ${hbSeconds}s • Phản hồi cuối: ${lastSeenText}">
                    <i class="fa-solid fa-heart-pulse text-rose-400 text-[9px]"></i><span>${hbSeconds}s</span><span class="text-slate-600">•</span><span>${lastSeenText}</span>
                </div>
            `;
        } else if (d.connection_status === 'PROCESSING') {
            statusHtml = `
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40"><i class="fa-solid fa-spinner fa-spin"></i>Đang xử lý</span>
                <div class="text-[10px] hc-text-muted mt-1 font-mono flex items-center gap-1" title="Chu kỳ Heartbeat: ${hbSeconds}s • Phản hồi cuối: ${lastSeenText}">
                    <i class="fa-solid fa-heart-pulse text-rose-400 text-[9px]"></i><span>${hbSeconds}s</span><span class="text-slate-600">•</span><span>${lastSeenText}</span>
                </div>
            `;
        } else if (d.connection_status === 'MAINTENANCE') {
            statusHtml = `
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/40"><i class="fa-solid fa-screwdriver-wrench"></i>Bảo trì</span>
                <div class="text-[10px] hc-text-muted mt-1 font-mono flex items-center gap-1" title="Chu kỳ Heartbeat: ${hbSeconds}s • Phản hồi cuối: ${lastSeenText}">
                    <i class="fa-solid fa-heart-pulse text-rose-400 text-[9px]"></i><span>${hbSeconds}s</span><span class="text-slate-600">•</span><span>${lastSeenText}</span>
                </div>
            `;
        } else if (d.connection_status === 'ONLINE') {
            statusHtml = `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>Đang kết nối</span>
                <div class="text-[10px] hc-text-muted mt-1 font-mono flex items-center gap-1" title="Chu kỳ Heartbeat: ${hbSeconds}s • Phản hồi cuối: ${lastSeenText}">
                    <i class="fa-solid fa-heart-pulse text-rose-400 text-[9px]"></i><span>${hbSeconds}s</span><span class="text-slate-600">•</span><span>${lastSeenText}</span>
                </div>
            `;
        } else {
            statusHtml = `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-500/20 text-slate-400 border border-slate-500/40"><span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>Mất kết nối</span>
                <div class="text-[10px] hc-text-muted mt-1 font-mono flex items-center gap-1" title="Chu kỳ Heartbeat: ${hbSeconds}s • Phản hồi cuối: ${lastSeenText}">
                    <i class="fa-solid fa-heart-pulse text-rose-400 text-[9px]"></i><span>${hbSeconds}s</span><span class="text-slate-600">•</span><span>${lastSeenText}</span>
                </div>
            `;
        }

        const locText = d.loc_display || (d.has_gps && d.latitude && d.longitude ? `${Number(d.latitude).toFixed(6)}, ${Number(d.longitude).toFixed(6)}` : (d.address || '-'));

        if (row) {
            // Cập nhật hàng đã có
            row.setAttribute('data-conn', d.connection_status);
            row.setAttribute('data-type', d.device_type_raw || '');
            row.setAttribute('data-gps', d.gps_code || (d.has_gps ? 'GPS' : 'STATIC'));

            const statusCell = row.querySelector('.row-status');
            if (statusCell && statusCell.innerHTML !== statusHtml) {
                statusCell.innerHTML = statusHtml;
                if (d.connection_status === 'SOS') {
                    row.classList.add('bg-red-500/20');
                    setTimeout(() => row.classList.remove('bg-red-500/20'), 3000);
                }
            }

            const locCell = row.querySelector('.row-loc');
            if (locCell && locText) locCell.innerText = locText;

            // Bổ sung sự kiện click vào hàng để zoom bản đồ
            row.classList.add('cursor-pointer');
            row.onclick = (e) => handleDeviceRowClick(e, d.id);
            row.title = 'Nhấn vào hàng để chuyển sang Bản đồ và phóng to vị trí thiết bị này';

            const nameCell = row.querySelector('.row-name');
            if (nameCell && d.device_name) {
                nameCell.innerHTML = `
                    <div class="flex items-center gap-1.5">
                        <i class="fa-solid fa-location-dot text-xs text-cyan-500"></i>
                        <span>${d.device_name}</span>
                    </div>
                `;
            }

            const ownerCell = row.querySelector('.row-owner');
            if (ownerCell && (d.customer_name !== undefined || d.is_pending_assignment !== undefined)) {
                if (!d.customer_name || !d.customer_name.trim()) {
                    ownerCell.innerHTML = `
                        <div class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold border border-amber-500/40">
                          <i class="fa-solid fa-clock-rotate-left"></i> Chờ gán thông tin
                        </div>
                        <div class="mt-1">
                          <button type="button" onclick="event.stopPropagation(); triggerAssignModal('${d.id}')" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-bold transition flex items-center gap-1 shadow-sm">
                            <i class="fa-solid fa-user-pen"></i> Gán thông tin
                          </button>
                        </div>
                    `;
                } else {
                    ownerCell.innerHTML = `
                        <div class="font-medium flex items-center justify-between gap-1">
                          <span>${d.customer_name}</span>
                          <button type="button" onclick="event.stopPropagation(); triggerAssignModal('${d.id}')" class="text-cyan-400 hover:text-cyan-300 text-[10px] p-0.5" title="Sửa thông tin">
                            <i class="fa-solid fa-pen-to-square"></i>
                          </button>
                        </div>
                        <div class="hc-text-muted text-[11px]">${d.emergency_phone || '-'}</div>
                    `;
                }
            }
        } else {
            // Thiết bị mới -> Chèn hàng mới vào đầu bảng
            const newTr = document.createElement('tr');
            newTr.className = 'device-row hover:bg-cyan-500/10 transition bg-cyan-500/20 cursor-pointer';
            newTr.setAttribute('data-id', d.id);
            newTr.setAttribute('data-deveui', d.dev_eui);
            newTr.setAttribute('data-type', d.device_type_raw || 'NUT_NHAN');
            newTr.setAttribute('data-conn', d.connection_status);
            newTr.setAttribute('data-gps', d.gps_code || (d.has_gps ? 'GPS' : 'STATIC'));
            newTr.setAttribute('onclick', `handleDeviceRowClick(event, '${d.id}')`);
            newTr.setAttribute('title', 'Nhấn vào hàng để chuyển sang Bản đồ và phóng to vị trí thiết bị này');

            const isGpsDev = Boolean(d.has_gps);
            const typeBg = d.type_bg || (d.device_type_raw === 'CAMERA' ? 'bg-blue-600' : (d.device_type_raw === 'GATEWAY' ? 'bg-purple-600' : (isGpsDev ? 'bg-sky-600' : 'bg-cyan-600')));
            const typeLabel = d.type_label || (isGpsDev ? 'Thiết bị GPS' : (d.device_type || 'Nút nhấn'));
            const catCls = d.cat_cls || 'border-emerald-500 text-emerald-400 bg-emerald-500/10';
            const catLabel = d.cat_label || d.category_type_display || 'Cấp Cứu/Y tế';

            newTr.innerHTML = `
                <td class="p-3.5"><input type="checkbox" class="dev-check" value="${d.id}" onclick="event.stopPropagation()" /></td>
                <td class="p-3.5 whitespace-nowrap row-type">
                  <span class="inline-block whitespace-nowrap ${typeBg} text-white px-3 py-1 rounded-full text-[11px] font-bold">${typeLabel}</span>
                </td>
                <td class="p-3.5 whitespace-nowrap row-cat">
                  <span class="inline-block whitespace-nowrap border ${catCls} px-3 py-0.5 rounded-full text-[11px] font-semibold">${catLabel}</span>
                </td>
                <td class="p-3.5 font-bold row-name text-cyan-400 hover:text-cyan-300">
                  <div class="flex items-center gap-1.5">
                    <i class="fa-solid fa-location-dot text-xs text-cyan-500"></i>
                    <span>${d.device_name}</span>
                  </div>
                </td>
                <td class="p-3.5 font-mono hc-text-muted row-deveui">${d.dev_eui}</td>
                <td class="p-3.5 row-group whitespace-nowrap">
                  ${d.parent_device_name ? `
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[11px] font-bold" title="Cùng nhà với: ${d.parent_device_name}">
                        <i class="fa-solid fa-house-user text-cyan-400"></i>
                        <span class="truncate max-w-[130px]">${d.group_name || ('Cùng: ' + d.parent_device_name)}</span>
                      </span>
                      <button type="button" onclick="event.stopPropagation(); openQuickPairModal('${d.id}', '${d.device_name}', '${d.parent_device_id || ''}', '${d.group_name || ''}')" class="text-cyan-400 hover:text-white p-1 text-[11px]" title="Đổi nhóm">
                        <i class="fa-solid fa-pen-to-square"></i>
                      </button>
                    </div>
                  ` : (d.paired_buttons_count > 0 ? `
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/15 text-purple-300 border border-purple-500/30 text-[11px] font-bold">
                        <i class="fa-solid fa-house text-purple-400"></i>
                        <span>${d.group_name ? d.group_name + ' • ' : ''}${d.paired_buttons_count} thiết bị cùng nhà</span>
                      </span>
                      <button type="button" onclick="event.stopPropagation(); openQuickPairModal('${d.id}', '${d.device_name}', '', '${d.group_name || ''}')" class="text-purple-400 hover:text-white p-1 text-[11px]" title="Chỉnh sửa nhóm">
                        <i class="fa-solid fa-pen-to-square"></i>
                      </button>
                    </div>
                  ` : (d.group_name ? `
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold">
                        <i class="fa-solid fa-users-rectangle text-emerald-400"></i>
                        <span class="truncate max-w-[130px]">${d.group_name}</span>
                      </span>
                      <button type="button" onclick="event.stopPropagation(); openQuickPairModal('${d.id}', '${d.device_name}', '', '${d.group_name}')" class="text-emerald-400 hover:text-white p-1 text-[11px]" title="Đổi nhóm">
                        <i class="fa-solid fa-pen-to-square"></i>
                      </button>
                    </div>
                  ` : `
                    <button type="button" onclick="event.stopPropagation(); openQuickPairModal('${d.id}', '${d.device_name}', '', '')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-cyan-600/30 text-slate-300 hover:text-cyan-300 text-[11px] font-semibold border border-dashed border-slate-600 transition flex items-center gap-1 shadow-sm" title="Gán thiết bị này cùng nhà với thiết bị khác">
                      <i class="fa-solid fa-link text-[10px] text-cyan-400"></i> Gán thiết bị
                    </button>
                  `))}
                </td>
                <td class="p-3.5 row-owner">
                  ${(!d.customer_name || !d.customer_name.trim()) ? `
                    <div class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold border border-amber-500/40">
                      <i class="fa-solid fa-clock-rotate-left"></i> Chờ gán thông tin
                    </div>
                    <div class="mt-1">
                      <button type="button" onclick="event.stopPropagation(); triggerAssignModal('${d.id}')" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-bold transition flex items-center gap-1 shadow-sm">
                        <i class="fa-solid fa-user-pen"></i> Gán thông tin
                      </button>
                    </div>
                  ` : `
                    <div class="font-medium flex items-center justify-between gap-1">
                      <span>${d.customer_name}</span>
                      <button type="button" onclick="event.stopPropagation(); triggerAssignModal('${d.id}')" class="text-cyan-400 hover:text-cyan-300 text-[10px] p-0.5" title="Sửa thông tin">
                        <i class="fa-solid fa-pen-to-square"></i>
                      </button>
                    </div>
                    <div class="hc-text-muted text-[11px]">${d.emergency_phone || '-'}</div>
                  `}
                </td>
                <td class="p-3.5 row-loc">${locText}</td>
                <td class="p-3.5 font-semibold whitespace-nowrap row-status">${statusHtml}</td>
            `;
            tbody.prepend(newTr);
            setTimeout(() => newTr.classList.remove('bg-cyan-500/20'), 4000);
        }
    });
}
window.updateDeviceTableRealtime = updateDeviceTableRealtime;

// ================= 8. CẬP NHẬT LỊCH SỬ BÁO ĐỘNG REAL-TIME (0ms KHÔNG CẦN LOAD LẠI TRANG) =================
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

function updateAlertsTableRealtime(alerts) {
    if (!alerts || !Array.isArray(alerts)) return;

    const tbody = document.getElementById('alerts-table-body');
    if (!tbody) return;

    if (alerts.length === 0) {
        tbody.innerHTML = `
            <tr id="empty-alerts-row">
                <td colspan="6" class="p-6 text-center hc-text-muted">Chưa có sự kiện SOS nào.</td>
            </tr>
        `;
        return;
    }

    let html = '';
    alerts.forEach(log => {
        let statusBadge = '';
        if (log.status === 'NEW') {
            statusBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/50 animate-pulse"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeHtml(log.status_display || 'Chưa xử lý (Mới)')}</span>`;
        } else if (log.status === 'PROCESSING') {
            statusBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40"><i class="fa-solid fa-spinner fa-spin mr-1"></i>${escapeHtml(log.status_display || 'Đang xử lý')}</span>`;
        } else if (log.status === 'RESOLVED') {
            statusBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"><i class="fa-solid fa-check mr-1"></i>${escapeHtml(log.status_display || 'Đã hoàn tất')}</span>`;
        } else {
            statusBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-500/20 text-slate-400 border border-slate-500/40">${escapeHtml(log.status_display || 'Báo động giả')}</span>`;
        }

        let actionButton = '';
        if (log.is_open) {
            actionButton = `
                <button type="button" 
                    data-id="${log.id}" 
                    data-name="${escapeHtml(log.device_name)}" 
                    data-eui="${escapeHtml(log.dev_eui)}" 
                    onclick="openCoordinationModal(this.dataset.id, this.dataset.name, this.dataset.eui)" 
                    class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-3 py-1.5 rounded-lg text-xs transition shadow-sm cursor-pointer">
                    Điều phối / Đóng hồ sơ
                </button>
            `;
        } else {
            actionButton = `<span class="text-emerald-500 font-semibold"><i class="fa-solid fa-check-circle mr-1"></i>Đã đóng băng</span>`;
        }

        const deleteButton = window.IS_ADMIN ? `
            <button type="button" 
                onclick="deleteSingleAlertDashboard(${log.id})" 
                class="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition cursor-pointer" 
                title="Xóa bản ghi sự cố #SOS-${log.id}">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        ` : '';

        html += `
            <tr class="hover:bg-cyan-500/10 transition" data-alert-id="${log.id}">
                <td class="p-3.5 whitespace-nowrap">
                    <div class="font-bold text-red-500">#SOS-${log.id}</div>
                    <div class="hc-text-muted">${escapeHtml(log.created_at)}</div>
                </td>
                <td class="p-3.5">
                    <div class="font-semibold">${escapeHtml(log.device_name)}</div>
                    <div class="hc-text-muted font-mono">${escapeHtml(log.dev_eui)}</div>
                </td>
                <td class="p-3.5">${escapeHtml(log.loc_display)}</td>
                <td class="p-3.5 whitespace-nowrap">${statusBadge}</td>
                <td class="p-3.5">
                    <div><strong>Điều phối:</strong> <span>${escapeHtml(log.notes_display)}</span></div>
                    <div><strong>Kết quả:</strong> <span>${escapeHtml(log.report_display)}</span></div>
                </td>
                <td class="p-3.5 whitespace-nowrap">
                    <div class="flex items-center gap-2">
                        ${actionButton}
                        ${deleteButton}
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}
window.updateAlertsTableRealtime = updateAlertsTableRealtime;

// ==============================================================================
// XÓA LỊCH SỬ BÁO ĐỘNG (DASHBOARD ADMIN)
// ==============================================================================
async function deleteSingleAlertDashboard(alertId) {
    if (!confirm(`Bạn có chắc chắn muốn xóa bản ghi sự cố #SOS-${alertId} không?`)) {
        return;
    }
    try {
        const res = await fetch('/api/alerts/delete/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_single', alert_id: alertId })
        });
        const json = await res.json();
        if (json.status === 'success') {
            showToast(json.message || `Đã xóa bản ghi #SOS-${alertId}`, 'success');
            const row = document.querySelector(`tr[data-alert-id="${alertId}"]`);
            if (row) {
                row.remove();
                const tbody = document.getElementById('alerts-table-body');
                if (tbody && tbody.querySelectorAll('tr[data-alert-id]').length === 0) {
                    tbody.innerHTML = `
                        <tr id="empty-alerts-row">
                            <td colspan="6" class="p-6 text-center hc-text-muted">Chưa có sự kiện SOS nào.</td>
                        </tr>
                    `;
                }
            }
        } else {
            showToast(json.message || 'Lỗi khi xóa sự cố!', 'error');
        }
    } catch (err) {
        showToast('Lỗi mạng khi thực hiện xóa!', 'error');
    }
}
window.deleteSingleAlertDashboard = deleteSingleAlertDashboard;

async function confirmClearAllAlertsDashboard() {
    if (!confirm("CẢNH BÁO: Thao tác này sẽ xóa vĩnh viễn TOÀN BỘ lịch sử báo động trong hệ thống và đưa thiết bị về trạng thái bình thường. Bạn có chắc chắn muốn xóa không?")) {
        return;
    }
    try {
        const res = await fetch('/api/alerts/delete/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_all' })
        });
        const json = await res.json();
        if (json.status === 'success') {
            showToast(json.message || 'Đã xóa toàn bộ lịch sử báo động thành công!', 'success');
            const tbody = document.getElementById('alerts-table-body');
            if (tbody) {
                tbody.innerHTML = `
                    <tr id="empty-alerts-row">
                        <td colspan="6" class="p-6 text-center hc-text-muted">Chưa có sự kiện SOS nào.</td>
                    </tr>
                `;
            }
        } else {
            showToast(json.message || 'Lỗi khi xóa toàn bộ sự cố!', 'error');
        }
    } catch (err) {
        showToast('Lỗi mạng khi xóa sự cố!', 'error');
    }
}
window.confirmClearAllAlertsDashboard = confirmClearAllAlertsDashboard;

if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", initDashboard);
} else {
    initDashboard();
}