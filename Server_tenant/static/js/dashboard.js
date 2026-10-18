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
const DEFAULT_MAP_ZOOM = 6;

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
    worldCopyJump: false
});

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

let markersLayer = L.layerGroup().addTo(map);
let routeLayer = L.layerGroup().addTo(map);
let currentAlertId = null;
let currentEmergencyDeviceId = null;
let currentEmergencyCoords = null;

// Lưu danh sách Marker theo ID để KHÔNG xóa/tạo lại làm mất Popup đang mở
let deviceMarkersMap = {};

// Đóng / Mở Sidebar và tự động co giãn lại bản đồ
function toggleSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('sidebar-collapsed');
    setTimeout(() => {
        map.invalidateSize();
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
    if (!sirenInterval) sirenInterval = setInterval(playSirenBeep, 500);
}

function stopSiren() {
    if (sirenInterval) {
        clearInterval(sirenInterval);
        sirenInterval = null;
    }
}

function toggleSoundSetting() {
    soundEnabled = !soundEnabled;
    document.getElementById('text-sound').innerText = soundEnabled ? "Âm báo: BẬT" : "Âm báo: TẮT";
    document.getElementById('icon-sound').className = soundEnabled
        ? "fa-solid fa-volume-high text-emerald-400 mr-1.5"
        : "fa-solid fa-volume-xmark text-slate-400 mr-1.5";
    if (!soundEnabled) stopSiren();
}

// ================= 3. RENDER MARKER THIẾT BỊ & TỰ ĐỘNG CĂN CHỈNH ZOOM =================
let hasInitialMapFit = false;

// Tự động căn chỉnh và zoom khung nhìn bản đồ bao quát toàn bộ vị trí các thiết bị với hiệu ứng mượt mà
function fitMapToDevices(animate = true, duration = 1.6) {
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

    if (coords.length === 1) {
        if (animate && typeof map.flyTo === 'function') {
            map.flyTo(coords[0], 14, { duration: duration, easeLinearity: 0.25 });
        } else {
            map.setView(coords[0], 14);
        }
        return true;
    }

    const bounds = L.latLngBounds(coords);
    if (!bounds.isValid()) return false;

    if (animate && typeof map.flyToBounds === 'function') {
        map.flyToBounds(bounds, {
            padding: [50, 50],
            maxZoom: 15,
            duration: duration,
            easeLinearity: 0.25
        });
    } else {
        map.fitBounds(bounds, {
            padding: [50, 50],
            maxZoom: 15,
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
            typeName: 'Cứu hộ tàu thuyền (GPS)',
            iconClass: 'fa-ship',
            shapeClass: 'pin-ship',
            prefixIcon: '🚢'
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
    // Nút nhấn khẩn cấp
    let icon = 'fa-bell';
    let typeName = 'Nút nhấn khẩn cấp';
    if (d.category_type === 'CHAY') {
        icon = 'fa-fire';
        typeName = 'Nút Báo Cháy (Đất liền)';
    } else if (d.category_type === 'AN_NINH') {
        icon = 'fa-shield-halved';
        typeName = 'Nút An Ninh (Đất liền)';
    } else if (d.category_type === 'CAP_CUU_Y_TE') {
        icon = 'fa-heart-pulse';
        typeName = 'Nút Cấp Cứu Y Tế';
    }
    return {
        categoryKey: 'button',
        typeName: typeName,
        iconClass: icon,
        shapeClass: 'pin-button',
        prefixIcon: '🔔'
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
                <div><strong>DevEUI:</strong> <span class="font-mono text-slate-700">${d.dev_eui}</span></div>
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
    if (!hasInitialMapFit) {
        hasInitialMapFit = true;
        if (!data.emergency) {
            // Chờ một nhịp ngắn (300ms) sau khi vẽ xong marker để kích hoạt hiệu ứng zoom lướt mượt mà vào thiết bị
            setTimeout(() => {
                fitMapToDevices(true, 1.8);
            }, 300);
        }
    } else if (forceFit === true) {
        if (!data.emergency) {
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
        if (data.emergency.notes) {
            if (notesRow) notesRow.classList.remove('hidden');
            if (notesEl) notesEl.innerText = data.emergency.notes;
            if (sosNotesInput) sosNotesInput.value = data.emergency.notes;
        } else {
            if (notesRow) notesRow.classList.add('hidden');
            if (notesEl) notesEl.innerText = '';
        }

        document.getElementById('step3-box').classList.remove('hidden');
        document.getElementById('step4-5-box').classList.add('hidden');
        document.getElementById('emergency-modal').classList.remove('hidden');
        startSiren();
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

    const mapSec = document.getElementById('section-map');
    if (mapSec) mapSec.classList.remove('hidden');

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
    if (!devId) return alert("Vui lòng chọn một thiết bị cứu hộ biển (có GPS)!");

    const res = await fetch(`/api/devices/${devId}/route/?range=${range}`);
    const data = await res.json();
    routePoints = data.points;
    document.getElementById('route-distance').innerText = `${data.total_distance_km} km`;

    routeLayer.clearLayers();
    if (routePoints.length === 0) return alert("Không có dữ liệu tọa độ trong khoảng thời gian này.");

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
                        <div><strong>Tình trạng tàu:</strong> <span class="bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold text-[11px]">⚠️ BÁO ĐỘNG KHẨN CẤP!</span></div>
                        <div><strong>Vận tốc lúc đó:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                        ${isEnd ? '<div class="text-[11px] text-sky-700 font-semibold mt-1">⚓ Đây cũng là vị trí ghi nhận cuối cùng</div>' : ''}
                        ${isStart ? '<div class="text-[11px] text-emerald-700 font-semibold mt-1">🏁 Đây cũng là điểm xuất phát</div>' : ''}
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-ship"></i> Tua tàu đến điểm SOS này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: sosIcon, zIndexOffset: 1500 }).addTo(routeLayer).bindPopup(sosPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else if (isStart) {
            // 🏁 ĐIỂM XUẤT PHÁT
            const startIcon = L.divIcon({
                className: '',
                html: `<div class="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded shadow-md border border-white whitespace-nowrap cursor-pointer transition">🏁 Xuất phát</div>`,
                iconSize: [68, 20],
                iconAnchor: [34, 20]
            });
            const startPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-emerald-700 border-b border-emerald-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <span>🏁</span> <span>ĐIỂM XUẤT PHÁT</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian xuất bến:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> Bắt đầu hành trình</div>
                        <div><strong>Vận tốc ban đầu:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(0)" class="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-ship"></i> Tua tàu về điểm xuất phát
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
                        <i class="fa-solid fa-anchor text-sky-600"></i> <span>ĐIỂM HIỆN TẠI / KẾT THÚC</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> Vị trí cuối hành trình</div>
                        <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-sky-700 hover:bg-sky-800 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-ship"></i> Tua tàu đến điểm cuối
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: endIcon, zIndexOffset: 1000 }).addTo(routeLayer).bindPopup(endPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        } else if (pt.speed === 0 || pt.is_drifting) {
            // ⚓ ĐIỂM TÀU DỪNG HOẶC TRÔI DẠT
            const stopIcon = L.divIcon({
                className: '',
                html: `<div class="w-5 h-5 rounded-full bg-amber-500 border-2 border-white flex items-center justify-center text-white text-[9px] shadow-md hover:scale-150 transition cursor-pointer" title="Điểm tàu dừng / neo đậu #${idx + 1}"><i class="fa-solid fa-anchor"></i></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            const stopPopup = `
                <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
                    <div class="font-bold text-sm text-amber-600 border-b border-amber-200 pb-1 mb-1.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-anchor text-amber-600"></i> <span>ĐIỂM TÀU DỪNG / NEO ĐẬU #${idx + 1}</span>
                    </div>
                    <div class="space-y-1 mb-2.5">
                        <div><strong>Thời gian ghi nhận:</strong> ${pt.time}</div>
                        <div><strong>Tình trạng:</strong> <span class="text-amber-600 font-bold">${pt.is_drifting ? 'Trôi dạt tự do' : 'Đang neo đậu (0 km/h)'}</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-ship"></i> Tua tàu đến điểm này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: stopIcon, zIndexOffset: 500 }).addTo(routeLayer).bindPopup(stopPopup, { autoClose: true, closeOnClick: true });
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
                        <div><strong>Tình trạng:</strong> <span class="text-emerald-600 font-medium">Đang hành trình trên biển</span></div>
                        <div><strong>Vận tốc:</strong> <span class="font-bold text-sky-700">${pt.speed} km/h</span></div>
                        <div><strong>Dung lượng Pin:</strong> <span class="font-bold text-emerald-600">${pt.battery}%</span></div>
                        <div><strong>Tọa độ GPS:</strong> <span class="font-mono text-slate-700">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span></div>
                    </div>
                    <button onclick="window.seekRoute(${idx})" class="w-full py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold rounded shadow transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-ship"></i> Tua tàu đến điểm này
                    </button>
                </div>
            `;
            const m = L.marker([pt.lat, pt.lng], { icon: waypointIcon, zIndexOffset: 300 }).addTo(routeLayer).bindPopup(waypointPopup, { autoClose: true, closeOnClick: true });
            m.on('click', () => { seekRoute(idx, false); });
        }
    });

    // 3. MARKER TÀU DI CHUYỂN TRÊN HÀNH TRÌNH
    const movingShipIcon = L.divIcon({
        className: '',
        html: `<div class="w-8 h-8 rounded-full bg-orange-600 border-2 border-white flex items-center justify-center text-white text-xs shadow-xl ring-4 ring-orange-300">
            <i class="fa-solid fa-ship"></i>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    movingMarker = L.marker(latlngs[0], { icon: movingShipIcon, zIndexOffset: 2000 }).addTo(routeLayer);
    movingMarker.bindPopup('', { autoClose: true, closeOnClick: true });

    document.getElementById('route-slider').max = routePoints.length - 1;
    document.getElementById('route-slider').value = 0;
    playIndex = 0;
    seekRoute(0);
}

function togglePlayRoute() {
    if (routePoints.length === 0) return;
    if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
        document.getElementById('btn-play').innerHTML = '<i class="fa-solid fa-play"></i>';
    } else {
        document.getElementById('btn-play').innerHTML = '<i class="fa-solid fa-pause"></i>';
        playTimer = setInterval(() => {
            if (playIndex >= routePoints.length) {
                togglePlayRoute();
                return;
            }
            seekRoute(playIndex);
            playIndex++;
        }, 800 / playSpeedMultiplier);
    }
}

function seekRoute(idx, openShipPopup = true) {
    playIndex = parseInt(idx);
    const pt = routePoints[playIndex];
    if (!pt || !movingMarker) return;

    movingMarker.setLatLng([pt.lat, pt.lng]);

    let statusText = '<span class="text-emerald-600 font-semibold">Đang hành trình trên biển</span>';
    if (pt.is_sos) {
        statusText = '<span class="text-red-600 font-bold uppercase">🚨 Báo động SOS khẩn cấp!</span>';
    } else if (pt.speed === 0 || pt.is_drifting) {
        statusText = '<span class="text-amber-600 font-bold">⚓ Tàu đang dừng / neo đậu</span>';
    }

    const popupHtml = `
        <div class="text-xs text-slate-900 font-sans p-1 min-w-[210px]">
            <div class="font-bold text-sm text-orange-600 border-b pb-1 mb-1 flex items-center gap-1.5">
                <i class="fa-solid fa-ship"></i> <span>VỊ TRÍ HÀNH TRÌNH TÀU</span>
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

    document.getElementById('route-slider').value = playIndex;
    document.getElementById('route-speed').innerText = `${pt.speed} km/h`;
}
window.seekRoute = seekRoute;

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
    const hasGps = document.getElementById('reg-has-gps').value === 'true';
    const addrGroup = document.getElementById('address-only-field');
    if (addrGroup) addrGroup.style.display = hasGps ? 'none' : 'block';
}

function openAddDeviceModal() {
    document.getElementById('add-device-modal').classList.remove('hidden');
}
function closeAddDeviceModal() {
    document.getElementById('add-device-modal').classList.add('hidden');
}

async function submitNewDevice() {
    const payload = {
        device_type: document.getElementById('reg-device-type')?.value || 'NUT_NHAN',
        category_type: document.getElementById('reg-category-type')?.value || 'CAP_CUU_Y_TE',
        device_name: document.getElementById('reg-name').value.trim(),
        dev_eui: document.getElementById('reg-deveui').value.trim(),
        customer_name: document.getElementById('reg-owner').value.trim(),
        emergency_phone: document.getElementById('reg-phone').value.trim(),
        has_gps: document.getElementById('reg-has-gps').value === 'true',
        address: document.getElementById('reg-address').value.trim(),
        latitude: parseFloat(document.getElementById('reg-lat').value) || 16.054407,
        longitude: parseFloat(document.getElementById('reg-lng').value) || 108.202167
    };

    if (!payload.device_name || !payload.dev_eui) {
        return alert("Vui lòng nhập đầy đủ Tên thiết bị và Mã ID/DevEUI!");
    }

    const res = await fetch('/api/devices/register/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (res.ok && result.status === 'success') {
        sessionStorage.setItem('active_hc_tab', 'devices');
        alert("✅ " + result.message);
        location.reload();
    } else {
        alert("❌ " + (result.message || "Không thể đăng ký thiết bị"));
    }
}

function filterDeviceTable() {
    const q = (document.getElementById('dev-search-input')?.value || '').toLowerCase();
    const t = document.getElementById('dev-type-filter')?.value || '';
    const c = document.getElementById('dev-conn-filter')?.value || '';
    const g = document.getElementById('dev-gps-filter')?.value || '';

    document.querySelectorAll('.device-row').forEach(row => {
        const textMatch = row.innerText.toLowerCase().includes(q);
        const typeMatch = !t || row.dataset.type === t;
        const connMatch = !c || row.dataset.conn === c;
        const gpsMatch = !g || row.dataset.gps === g;
        row.style.display = (textMatch && typeMatch && connMatch && gpsMatch) ? '' : 'none';
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
        if (slider) slider.value = 0;
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        const distEl = document.getElementById('route-distance');
        if (distEl) distEl.innerText = '0.00 km';
        const speedEl = document.getElementById('route-speed');
        if (speedEl) speedEl.innerText = '0 km/h';

        showMapTab(false);
        refreshMapMarkers();
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

        const target = document.getElementById(`section-${tab}`);
        if (target) target.classList.remove('hidden');
        if (tab === 'stats') {
            loadStatsData();
        }
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
    if (theme === 'light') {
        body.classList.remove('theme-dark', 'dark');
        html.classList.remove('dark');
        body.classList.add('theme-light');
        if (icon) icon.className = 'fa-solid fa-moon text-cyan-700 mr-1.5';
        if (text) text.innerText = 'Nền: SÁNG';
    } else {
        body.classList.remove('theme-light');
        body.classList.add('theme-dark', 'dark');
        html.classList.add('dark');
        if (icon) icon.className = 'fa-solid fa-sun text-amber-400 mr-1.5';
        if (text) text.innerText = 'Nền: TỐI';
    }
    localStorage.setItem('hc_dashboard_theme', theme);
}

function toggleTheme() {
    const isLight = document.body.classList.contains('theme-light');
    applyTheme(isLight ? 'dark' : 'light');
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
            const msg = JSON.parse(e.data);
            console.log("⚡ [SSE] Tín hiệu uplink mới từ thiết bị:", msg);
            if (msg.is_sos && msg.device_id) {
                currentEmergencyDeviceId = msg.device_id;
                if (msg.latitude && msg.longitude) {
                    currentEmergencyCoords = [msg.latitude, msg.longitude];
                }
                setEmergencyButtonState(true, msg.device_id);
            } else if (msg.resolved || msg.is_sos === false) {
                if (currentEmergencyDeviceId === msg.device_id) {
                    stopSiren();
                    currentEmergencyDeviceId = null;
                    currentEmergencyCoords = null;
                    currentAlertId = null;
                }
            }
            // Ngay lập tức cập nhật bản đồ và kích hoạt cảnh báo (0ms delay)
            refreshMapMarkers();
        } catch (err) {
            console.error("Lỗi đọc gói tin SSE:", err);
        }
    });

    sse.onerror = () => {
        console.warn("Mất kết nối SSE, trình duyệt sẽ tự động kết nối lại...");
    };
}

document.addEventListener("DOMContentLoaded", () => {
    const savedTheme = localStorage.getItem('hc_dashboard_theme') || 'dark';
    applyTheme(savedTheme);
    verifyMapVinaKey();
    initStatsChart();
    refreshMapMarkers();
    initSSE();
    setInterval(refreshMapMarkers, 5000);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeManualSOSModal();
            closeEmergencyModal();
            if (typeof closeAddDeviceModal === 'function') closeAddDeviceModal();
        }
    });
});