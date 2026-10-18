from django.contrib import admin
from .models import User, Area, Device, AlertLog, LocationHistory

admin.site.register(User)
admin.site.register(Area)
admin.site.register(Device)
admin.site.register(AlertLog)
admin.site.register(LocationHistory)