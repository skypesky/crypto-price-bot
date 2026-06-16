import { Layout, Menu, Button, App as AntApp } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  DashboardOutlined,
  GoldOutlined,
  SettingOutlined,
  FileTextOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { apiPost } from '../api/client';

const { Sider, Header, Content } = Layout;

const items = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '总览' },
  { key: '/coins', icon: <GoldOutlined />, label: '币种' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
  { key: '/reports', icon: <FileTextOutlined />, label: '报表' },
  { key: '/account', icon: <UserOutlined />, label: '账户' },
];

export function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/dashboard';

  const handleLogout = async () => {
    try {
      await apiPost('/api/auth/logout');
      message.success('已退出登录');
      window.location.hash = '#/login';
    } catch {
      window.location.hash = '#/login';
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={220}>
        <div className="app-logo">📊 Crypto Bot</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={items}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: 'var(--ant-color-bg-container)',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: '0 24px',
            borderBottom: '1px solid var(--ant-color-border)',
          }}
        >
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </Header>
        <Content style={{ padding: 24, background: 'var(--ant-color-bg-layout)' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}