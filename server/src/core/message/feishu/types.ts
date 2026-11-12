/** 卡片 JSON 2.0 允许的主题色。 */
export type CardTemplate = 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'grey';

/** 分栏列容器。 */
export interface FeishuColumn {
  tag: 'column';
  width: 'weighted' | 'auto';
  weight?: number;
  padding?: string;
  background_style?: string;
  vertical_align?: 'top' | 'center' | 'bottom';
  elements: FeishuCardElement[];
}

/** 飞书 2.0 卡片元素（只覆盖展示类组件）。 */
export type FeishuCardElement =
  | {
      tag: 'markdown';
      content: string;
      text_size?: string;
      text_align?: 'left' | 'center' | 'right';
      margin?: string;
    }
  | { tag: 'hr'; margin?: string }
  | {
      tag: 'column_set';
      flex_mode?: 'none' | 'bisect' | 'stretch' | 'flow' | 'trisect';
      horizontal_spacing?: string;
      background_style?: string;
      columns: FeishuColumn[];
    }
  | FeishuColumn;

export interface FeishuCardPayload {
  msg_type: 'interactive';
  card: {
    schema: '2.0';
    config: { width_mode: 'fill' };
    header: {
      title: { tag: 'plain_text'; content: string };
      subtitle?: { tag: 'plain_text'; content: string };
      template: CardTemplate;
    };
    body: {
      direction: 'vertical';
      padding: string;
      vertical_spacing: string;
      elements: FeishuCardElement[];
    };
  };
}
