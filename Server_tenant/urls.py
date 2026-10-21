from django.urls import path
from . import views
from .hctech_webhook import hctech_webhook_view, api_sync_from_hctech

urlpatterns = [
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('', views.dashboard_view, name='dashboard'),

    path('admin/', views.admin_portal_view, name='admin_portal'),
    path('admin/api/<str:action>/', views.api_admin_action, name='api_admin_action'),

    path('api/state/', views.api_dashboard_state, name='api_dashboard_state'),
    path('api/stats/', views.api_stats_data, name='api_stats_data'),
    path('api/devices/register/', views.api_register_device, name='api_register_device'),
    path('api/devices/<int:device_id>/update/', views.api_update_device, name='api_update_device'),
    path('api/devices/<int:device_id>/pair/', views.api_quick_pair_device, name='api_quick_pair_device'),
    path('api/devices/delete/', views.api_delete_devices, name='api_delete_devices'),
    path('api/users/create/', views.api_create_user, name='api_create_user'),
    path('api/users/change-password/', views.api_change_password, name='api_change_password'),
    path('api/users/profile/', views.api_update_profile, name='api_update_profile'),
    path('api/users/delete/', views.api_delete_user, name='api_delete_user'),
    path('api/users/<int:user_id>/delete/', views.api_delete_user, name='api_delete_user_by_id'),

    path('api/geo/suggest/', views.api_geo_suggest, name='api_geo_suggest'),
    path('api/geo/reverse/', views.api_geo_reverse, name='api_geo_reverse'),

    path('api/webhook/uplink/', hctech_webhook_view, name='webhook_iot_uplink'),
    path('api/hctech/sync/', api_sync_from_hctech, name='api_sync_from_hctech'),

    path('events/', views.sse_stream, name='sse_stream_events_alias'),
    path('api/stream/events/', views.sse_stream, name='sse_stream'),
    path('api/alerts/<int:alert_id>/process/', views.api_process_alert, name='api_process_alert'),
    path('api/alerts/dispatch/', views.api_dispatch_emergency, name='api_dispatch_emergency'),
    path('api/alerts/turn_off_emergency/', views.api_turn_off_emergency, name='api_turn_off_emergency'),
    path('api/devices/<int:device_id>/turn_off_alert/', views.api_turn_off_device_alert, name='api_turn_off_device_alert'),
    path('api/devices/<int:device_id>/route/', views.api_route_history, name='api_route_history'),
    path('export/alerts/csv/', views.export_alerts_csv, name='export_alerts_csv'),
]
