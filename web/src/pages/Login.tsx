import { useState } from 'react';
import { Card, Form, Input, Button, App as AntApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../api/client';

interface LoginForm {
  username: string;
  password: string;
}

export function Login() {
  const [loading, setLoading] = useState(false);
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  const onFinish = async (values: LoginForm) => {
    setLoading(true);
    try {
      await apiPost<{ username: string }>('/api/auth/login', values);
      message.success('登录成功');
      navigate('/dashboard');
    } catch (err) {
      message.error((err as Error).message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <Card className="login-card" title="📊 Crypto Price Bot">
        <Form<LoginForm>
          layout="vertical"
          onFinish={onFinish}
          initialValues={{ username: '', password: '' }}
          autoComplete="off"
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input size="large" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}