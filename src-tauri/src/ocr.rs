//! 图片 OCR：macOS Vision 框架离线识别（VNRecognizeTextRequest，中英混排）。
//! 无网络请求；识别行按 Vision 返回顺序以换行拼接。

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
    VNRequestTextRecognitionLevel,
};
use tauri::AppHandle;

/// 识别图片附件中的文字。空结果返回 Err("未识别到文字")。
pub fn recognize(app: &AppHandle, file: &str) -> Result<String, String> {
    let bytes = crate::storage::read_image_bytes(app, file).ok_or("图片不存在")?;
    let data = NSData::with_bytes(&bytes);
    let handler = unsafe {
        VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        )
    };

    let request = unsafe { VNRecognizeTextRequest::new() };
    unsafe {
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        let langs = NSArray::from_retained_slice(&[
            NSString::from_str("zh-Hans"),
            NSString::from_str("en-US"),
        ]);
        request.setRecognitionLanguages(&langs);
    }

    let as_request: Retained<VNRequest> =
        Retained::into_super(Retained::into_super(request.clone()));
    let requests = NSArray::from_retained_slice(&[as_request]);
    unsafe { handler.performRequests_error(&requests) }
        .map_err(|e| format!("Vision 识别失败: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(results) = unsafe { request.results() } {
        for obs in results.iter() {
            let any: &AnyObject = &obs;
            if let Some(text_obs) = any.downcast_ref::<VNRecognizedTextObservation>() {
                if let Some(best) = text_obs.topCandidates(1).firstObject() {
                    let s = best.string().to_string();
                    if !s.trim().is_empty() {
                        lines.push(s);
                    }
                }
            }
        }
    }
    let text = lines.join("\n");
    if text.trim().is_empty() {
        Err("未识别到文字".into())
    } else {
        Ok(text)
    }
}
