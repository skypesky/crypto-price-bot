import { useEffect, useState } from 'react';
import { Card, Tabs, Form, Input, InputNumber, Switch, Button, App as AntApp, Space, Tooltip } from 'antd';
import { apiGet, apiPut } from '../api/client';

interface Settings {
  tg_bot_token: string | null;
  tg_chat_id: string | null;
  feishu_webhook_url: string | null;
  timezone: string;
  schedule_rule: string;
  usdt_to_cny: number;
  ua: string;
  doh_enabled: boolean;
  doh_server: string;
  doh_bypass: string;
  request_timeout_ms: number;
  max_retries: number;
}

export function SettingsPage() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Settings>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<Settings>('/api/settings').then((s) => {
    form.setFieldsValue({
      ...s,
      tg_bot_token: s.tg_bot_token ?? '',
      tg_chat_id: s.tg_chat_id ?? '',
      feishu_webhook_url: s.feishu_webhook_url ?? '',
      doh_bypass: Array.isArray(s.doh_bypass) ? s.doh_bypass.join(',') : (s.doh_bypass ?? ''),
    });
    });
  }, [form]);

  const save = async () => {
    setLoading(true);
    try {
      const v = await form.validateFields();
      const payload = {
        ...v,
        tg_bot_token: v.tg_bot_token || null,
        tg_chat_id: v.tg_chat_id || null,
        feishu_webhook_url: v.feishu_webhook_url || null,
        doh_bypass: v.doh_bypass.split(',').map((s: string) => s.trim()).filter(Boolean),
      };
      await apiPut('/api/settings', payload);
      message.success('已保存，配置立即生效');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Form<Settings> form={form} layout="vertical">
        <Tabs
          items={[
            {
              key: 'push',
              label: '推送通道',
              children: (
                <>
                  <Form.Item name="tg_bot_token" label={<Tooltip title="Telegram Bot Token (@BotFather 获取)">Telegram Bot Token</Tooltip>}>
                    <Input.Password placeholder="可选" />
                  </Form.Item>
                  <Form.Item name="tg_chat_id" label={<Tooltip title="Telegram Chat ID（用户或群组）">Telegram Chat ID</Tooltip>}>
                    <Input placeholder="可选" />
                  </Form.Item>
                  <Form.Item name="feishu_webhook_url" label={<Tooltip title="飞书机器人 Incoming Webhook URL">飞书 Webhook URL</Tooltip>}>
                    <Input placeholder="可选" />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'schedule',
              label: '调度',
              children: (
                <>
                  <Form.Item name="timezone" label={<Tooltip title="IANA 时区，如 Asia/Shanghai、UTC">时区</Tooltip>}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="schedule_rule" label={<Tooltip title="6 段 cron（含秒）：秒 分 时 日 月 周">调度规则（cron 6 段）</Tooltip>}>
                    <Input placeholder="0 0 9 * * *" />
                  </Form.Item>
                  <Form.Item name="usdt_to_cny" label={<Tooltip title="1 USDT 兑人民币汇率">USDT → CNY 汇率</Tooltip>}>
                    <InputNumber min={0.1} step={0.01} style={{ width: 200 }} />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'data',
              label: '数据源',
              children: (
                <>
                  <Form.Item name="ua" label={<Tooltip title="HTTP User-Agent 头">User-Agent</Tooltip>}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="doh_enabled" label={<Tooltip title="启用 DoH（DNS over HTTPS）防 DNS 污染">启用 DoH 兜底</Tooltip>} valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Form.Item name="doh_server" label={<Tooltip title="DoH 服务器（默认 1.1.1.1）">DoH 服务器</Tooltip>}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="doh_bypass" label={<Tooltip title="逗号分隔的直连域名列表（不走 DoH）">DoH 直连列表</Tooltip>}>
                    <Input placeholder="1.1.1.1,one.one.one.one" />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'advanced',
              label: '高级',
              children: (
                <>
                  <Form.Item name="request_timeout_ms" label="请求超时（ms）">
                    <InputNumber min={1000} max={120000} step={1000} />
                  </Form.Item>
                  <Form.Item name="max_retries" label="失败重试次数">
                    <InputNumber min={0} max={5} />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
        <Space>
          <Button type="primary" onClick={save} loading={loading}>保存</Button>
        </Space>
      </Form>
    </Card>
  );
}

export const Settings = SettingsPage;