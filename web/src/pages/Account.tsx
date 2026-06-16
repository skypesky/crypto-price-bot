import { useState } from 'react';
import { Card, Form, Input, Button, App as AntApp } from 'antd';
import { apiPost } from '../api/client';

interface PwForm {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

export function Account() {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<PwForm>();

  const submit = async () => {
    const v = await form.validateFields();
    if (v.newPassword !== v.confirm) {
      message.error('两次新密码不一致');
      return;
    }
    setLoading(true);
    try {
      await apiPost('/api/auth/change-password', {
        oldPassword: v.oldPassword,
        newPassword: v.newPassword,
      });
      message.success('密码已修改，请重新登录');
      setTimeout(() => { window.location.hash = '#/login'; }, 1500);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="修改密码" style={{ maxWidth: 480 }}>
      <Form<PwForm> form={form} layout="vertical">
        <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码（至少 8 字符）"
          rules={[{ required: true, min: 8, message: '至少 8 字符' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={['newPassword']}
          rules={[{ required: true }, ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
              return Promise.reject(new Error('两次密码不一致'));
            },
          })]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" onClick={submit} loading={loading}>提交</Button>
      </Form>
    </Card>
  );
}