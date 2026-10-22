from django.contrib import admin
from .models import User, Area, Device, AlertLog, LocationHistory

admin.site.register(User)
admin.site.register(Area)
admin.site.register(Device)
admin.site.register(LocationHistory)

@admin.register(AlertLog)
class AlertLogAdmin(admin.ModelAdmin):
    list_display = ('id', 'device', 'alert_type', 'status', 'created_at', 'resolved_at')
    list_filter = ('status', 'alert_type', 'created_at')
    search_fields = ('id', 'device__device_name', 'device__dev_eui', 'notes', 'resolution_report')
    actions = ['delete_selected', 'clear_all_alerts_action']

    @admin.action(description="Xóa toàn bộ lịch sử báo động (Purge All Alerts)")
    def clear_all_alerts_action(self, request, queryset):
        count, _ = AlertLog.objects.all().delete()
        self.message_user(request, f"Đã xóa sạch toàn bộ {count} bản ghi lịch sử sự cố báo động.")