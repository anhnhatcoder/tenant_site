from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    # Giao diện Django Model Admin tiêu chuẩn
    path('django-admin/', admin.site.urls),
    # Toàn bộ trang chủ Dashboard, trang Admin Portal riêng (/admin/) và APIs
    path('', include('Server_tenant.urls')),
]
