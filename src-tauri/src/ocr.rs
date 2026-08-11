//! 图片 OCR：macOS Vision 框架离线识别（VNRecognizeTextRequest，中英混排）。
//! 无网络请求；结构化接口保留置信度与 Vision 左下原点框，坐标转换由
//! image_firewall 统一完成。

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
    VNRequestTextRecognitionLevel,
};
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct RecognizedObservation {
    pub text: String,
    pub confidence: f32,
    pub vision_box: (f64, f64, f64, f64),
}

pub fn recognize_observations(bytes: &[u8]) -> Result<Vec<RecognizedObservation>, String> {
    let data = NSData::with_bytes(bytes);

    // 结构化识别允许空结果；旧字符串接口再决定是否将空结果视为错误。
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let langs =
        NSArray::from_retained_slice(&[NSString::from_str("zh-Hans"), NSString::from_str("en-US")]);
    request.setRecognitionLanguages(&langs);

    let as_request: Retained<VNRequest> =
        Retained::into_super(Retained::into_super(request.clone()));
    let requests = NSArray::from_retained_slice(&[as_request]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("Vision 识别失败: {e}"))?;

    let mut observations = Vec::new();
    if let Some(results) = request.results() {
        for obs in results.iter() {
            let any: &AnyObject = &obs;
            if let Some(text_obs) = any.downcast_ref::<VNRecognizedTextObservation>() {
                if let Some(best) = text_obs.topCandidates(1).firstObject() {
                    let s = best.string().to_string();
                    if !s.trim().is_empty() {
                        let bounds = unsafe { text_obs.boundingBox() };
                        observations.push(RecognizedObservation {
                            text: s,
                            confidence: best.confidence(),
                            vision_box: (
                                bounds.origin.x,
                                bounds.origin.y,
                                bounds.size.width,
                                bounds.size.height,
                            ),
                        });
                    }
                }
            }
        }
    }
    Ok(observations)
}

/// 旧图片卡 OCR 契约：仍返回换行拼接文本，空结果维持原错误语义。
pub fn recognize(app: &AppHandle, file: &str) -> Result<String, String> {
    let bytes = crate::storage::read_image_bytes(app, file).ok_or("图片不存在")?;
    let text = recognize_observations(&bytes)?
        .into_iter()
        .map(|observation| observation.text)
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        Err("未识别到文字".into())
    } else {
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    /// 手工发布门禁：fixture 必须只含 synthetic 数据；不把识别正文打印到日志。
    #[test]
    #[ignore = "设置 TOSKR_SYNTHETIC_OCR_FIXTURE 后手工运行"]
    fn synthetic_fixture_recognizes_email_and_fake_api_key() {
        let path =
            std::env::var("TOSKR_SYNTHETIC_OCR_FIXTURE").expect("缺少 synthetic OCR fixture 路径");
        let bytes = std::fs::read(path).expect("读取 synthetic OCR fixture 失败");
        let result = crate::image_firewall::scan_fixture_bytes("synthetic.png", &bytes)
            .expect("图片 Firewall 扫描失败");
        assert!(result.image_width > 0 && result.image_height > 0);
        assert!(result.observations.iter().all(|observation| {
            let bounds = observation.bounding_box;
            observation.image_width == result.image_width
                && observation.image_height == result.image_height
                && observation.confidence >= 0.0
                && observation.confidence <= 1.0
                && bounds.x >= 0.0
                && bounds.y >= 0.0
                && bounds.x + bounds.width <= 1.0
                && bounds.y + bounds.height <= 1.0
        }));
        assert!(
            result
                .findings
                .iter()
                .any(|finding| finding.category == crate::privacy::FindingCategory::Email),
            "synthetic 邮箱未被识别"
        );
        assert!(
            result
                .findings
                .iter()
                .any(|finding| finding.category == crate::privacy::FindingCategory::ApiKey),
            "synthetic API key 未被识别"
        );
    }
}
