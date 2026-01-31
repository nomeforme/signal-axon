/**
 * AWS Bedrock LLM Provider with Native Tool Support
 *
 * Standalone provider for AWS Bedrock's Claude models without connectome-ts dependency.
 * Supports native tool calling via the Bedrock converse API.
 */

import AWS from 'aws-sdk';
import type { LLMMessage, ToolSchema, ToolLLMOptions, ToolLLMResponse } from './anthropic-tool-provider.js';

export interface BedrockProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class BedrockProvider {
  private client: AWS.BedrockRuntime;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: BedrockProviderConfig) {
    this.client = new AWS.BedrockRuntime({
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
    });
    this.defaultModel = config.defaultModel || 'claude-3-5-sonnet-20241022';
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  private getBedrockModelId(modelName: string): string {
    const baseModel = modelName.replace(/^bedrock-/, '');

    if (baseModel.includes('claude-3-5-sonnet-20241022')) {
      return `us.anthropic.${baseModel}-v2:0`;
    }

    if (baseModel.includes('claude-3-opus')) {
      return `us.anthropic.${baseModel}-v1:0`;
    }

    return `anthropic.${baseModel}-v1:0`;
  }

  async generate(messages: LLMMessage[], options?: ToolLLMOptions): Promise<ToolLLMResponse> {
    const apiMessages = messages.filter(m => m.role !== 'cache');
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    const bedrockMessages = this.mergeConsecutiveMessages(
      conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: this.formatContent(msg)
      }))
    );

    const modelId = options?.modelId || this.defaultModel;
    const bedrockModelId = this.getBedrockModelId(modelId);

    const bedrockBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: bedrockMessages
    };

    if (systemMessage) {
      bedrockBody.system = systemMessage;
    }

    if (stopSequences.length > 0) {
      bedrockBody.stop_sequences = stopSequences;
    }

    if (options?.temperature !== undefined) {
      bedrockBody.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      bedrockBody.tools = options.tools;
    }

    console.log('[BedrockProvider:generate] Starting request...');
    console.log('[BedrockProvider:generate] Model ID:', bedrockModelId);

    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[BedrockProvider] Retry attempt ${attempt}/${this.maxRetries}`);
        }

        const params = {
          modelId: bedrockModelId,
          body: JSON.stringify(bedrockBody),
          contentType: 'application/json',
          accept: 'application/json'
        };

        const response = await this.client.invokeModel(params).promise();
        const responseBody = JSON.parse(response.body?.toString() || '{}');

        const textContent = responseBody.content
          ?.filter((block: any) => block.type === 'text')
          ?.map((block: any) => block.text)
          ?.join('') || '';

        const toolCalls = responseBody.content
          ?.filter((block: any) => block.type === 'tool_use')
          ?.map((block: any) => ({
            id: block.id,
            name: block.name,
            input: block.input
          })) || [];

        console.log('[BedrockProvider:generate] Stop reason:', responseBody.stop_reason);

        return {
          content: textContent,
          tokensUsed: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
          modelId: bedrockModelId,
          stopReason: responseBody.stop_reason as ToolLLMResponse['stopReason'],
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
      } catch (error: any) {
        lastError = error;
        console.error(`[BedrockProvider] Request failed:`, error.message);

        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);
        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }

    throw new Error(`Bedrock API error: ${lastError?.message || 'Unknown error'}`);
  }

  async sendToolResults(
    messages: LLMMessage[],
    assistantContent: any[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    options?: ToolLLMOptions
  ): Promise<ToolLLMResponse> {
    const apiMessages = messages.filter(m => m.role !== 'cache');
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    const bedrockMessages = this.mergeConsecutiveMessages(
      conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: this.formatContent(msg)
      }))
    );

    bedrockMessages.push({
      role: 'assistant',
      content: assistantContent
    });

    bedrockMessages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result',
        tool_use_id: tr.tool_use_id,
        content: tr.content
      }))
    });

    const modelId = options?.modelId || this.defaultModel;
    const bedrockModelId = this.getBedrockModelId(modelId);

    const bedrockBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: bedrockMessages
    };

    if (systemMessage) {
      bedrockBody.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      bedrockBody.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      bedrockBody.tools = options.tools;
    }

    const params = {
      modelId: bedrockModelId,
      body: JSON.stringify(bedrockBody),
      contentType: 'application/json',
      accept: 'application/json'
    };

    const response = await this.client.invokeModel(params).promise();
    const responseBody = JSON.parse(response.body?.toString() || '{}');

    const textContent = responseBody.content
      ?.filter((block: any) => block.type === 'text')
      ?.map((block: any) => block.text)
      ?.join('') || '';

    const toolCalls = responseBody.content
      ?.filter((block: any) => block.type === 'tool_use')
      ?.map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input
      })) || [];

    return {
      content: textContent,
      tokensUsed: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
      modelId: bedrockModelId,
      stopReason: responseBody.stop_reason as ToolLLMResponse['stopReason'],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  private formatContent(msg: LLMMessage): Array<{ type: string; text?: string; source?: any }> {
    const content = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;
    const contentBlocks: Array<{ type: string; text?: string; source?: any }> = [];

    const attachments = msg.metadata?.attachments;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const attachment of attachments) {
        const contentType = attachment.contentType || attachment.mimeType || '';
        const isImage = contentType.startsWith('image/');

        if (isImage && attachment.data) {
          const mediaType = this.getValidatedMediaType(attachment.data, contentType);
          if (mediaType) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: attachment.data
              }
            });
          }
        }
      }
    }

    if (content) {
      contentBlocks.push({ type: 'text', text: content });
    }

    return contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }];
  }

  private mergeConsecutiveMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: any }>
  ): Array<{ role: 'user' | 'assistant'; content: any }> {
    if (!messages || messages.length === 0) return messages;

    const merged: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i];

      if (current.role === 'user') {
        const userContents: any[] = [];

        while (i < messages.length && messages[i].role === 'user') {
          const content = messages[i].content;
          if (Array.isArray(content)) {
            userContents.push(...content);
          } else if (typeof content === 'string') {
            userContents.push({ type: 'text', text: content });
          }
          i++;
        }

        merged.push({ role: 'user', content: userContents });
      } else {
        if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
          merged.push({ role: 'user', content: [{ type: 'text', text: '[continue]' }] });
        }
        merged.push(current);
        i++;
      }
    }

    if (merged.length > 0 && merged[0].role === 'assistant') {
      merged.unshift({ role: 'user', content: [{ type: 'text', text: '[conversation history]' }] });
    }

    return merged;
  }

  private getValidatedMediaType(base64Data: string, declaredContentType: string): string | null {
    const detectedType = this.detectImageTypeFromBase64(base64Data);
    if (detectedType) return detectedType;

    const normalized = declaredContentType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
    if (normalized.includes('png')) return 'image/png';
    if (normalized.includes('gif')) return 'image/gif';
    if (normalized.includes('webp')) return 'image/webp';
    return 'image/jpeg';
  }

  private detectImageTypeFromBase64(base64Data: string): string | null {
    try {
      const buffer = Buffer.from(base64Data.slice(0, 32), 'base64');

      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
      }
      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
      }
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return 'image/gif';
      }
      if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
          buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
      }

      return null;
    } catch {
      return null;
    }
  }

  private isRetryableError(error: any): boolean {
    if (error.statusCode) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (retryableStatuses.includes(error.statusCode)) {
        return true;
      }
    }

    const message = (error.message || '').toLowerCase();
    return message.includes('throttl') ||
           message.includes('timeout') ||
           message.includes('connection');
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'bedrock';
  }
}
