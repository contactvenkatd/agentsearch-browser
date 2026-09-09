// Copyright 2026 The AgentSearch Authors

#include "chrome/browser/ui/views/side_panel/agent_search/agent_search_side_panel_view.h"

#include <limits>
#include <memory>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/escape.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/app/vector_icons/vector_icons.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_scope.h"
#include "components/prefs/pref_service.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "ui/base/models/image_model.h"
#include "ui/base/page_transition_types.h"
#include "ui/color/color_provider.h"
#include "ui/events/event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/color_palette.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/background.h"
#include "ui/views/border.h"
#include "ui/views/controls/button/image_button.h"
#include "ui/views/controls/button/label_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/scroll_view.h"
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/controls/textfield/textfield_controller.h"
#include "ui/views/controls/throbber.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/view.h"

namespace {

constexpr SkColor kPanelBackground = SkColorSetRGB(0x1A, 0x1A, 0x1C);
constexpr SkColor kSurface = SkColorSetRGB(0x23, 0x23, 0x26);
constexpr SkColor kPrimaryText = SkColorSetRGB(0xEC, 0xEC, 0xEE);
constexpr SkColor kMutedText = SkColorSetRGB(0xC4, 0xC4, 0xC8);
constexpr char kAgentSearchChatHistoryPref[] = "agentsearch.chat_history";
constexpr char kAgentBridgeBaseUrl[] = "http://127.0.0.1:9333";
constexpr size_t kMaxBridgeResponseBytes = 1024 * 1024;
constexpr int kAutoScrollTolerance = 32;

std::unique_ptr<views::Label> CreateLabel(const std::u16string& text,
                                          SkColor color,
                                          int font_delta = 0) {
  auto label = std::make_unique<views::Label>(text);
  label->SetEnabledColor(color);
  label->SetHorizontalAlignment(gfx::ALIGN_LEFT);
  if (font_delta) {
    label->SetFontList(label->font_list().DeriveWithSizeDelta(font_delta));
  }
  return label;
}

std::unique_ptr<views::LabelButton> CreatePromptCard(
    const std::u16string& text,
    views::Button::PressedCallback callback) {
  auto button = std::make_unique<views::LabelButton>(std::move(callback), text);
  button->SetHorizontalAlignment(gfx::ALIGN_LEFT);
  button->SetEnabledTextColors(kMutedText);
  button->SetBackground(views::CreateRoundedRectBackground(kSurface, 10));
  button->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(12, 14)));
  button->SetPreferredSize(gfx::Size(250, 42));
  return button;
}

class AgentSearchSidePanelView : public views::View,
                                 public views::TextfieldController {
 public:
  explicit AgentSearchSidePanelView(BrowserWindowInterface* browser)
      : browser_(browser) {
    SetBackground(views::CreateSolidBackground(kPanelBackground));
    SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(18, 18)));
    auto* root_layout = SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical, gfx::Insets(), 14));

    auto* header = AddChildView(std::make_unique<views::View>());
    header->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 9));

    auto* badge = header->AddChildView(
        CreateLabel(u"✦", SkColorSetRGB(0x06, 0x17, 0x0E), 0));
    badge->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    badge->SetVerticalAlignment(gfx::ALIGN_MIDDLE);
    badge->SetPreferredSize(gfx::Size(24, 24));
    badge->SetBackground(views::CreateRoundedRectBackground(
        SkColorSetRGB(0x3D, 0xDC, 0x84), 12));

    auto* header_text = header->AddChildView(std::make_unique<views::View>());
    header_text->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical, gfx::Insets(), 0));
    auto* title = header_text->AddChildView(
        CreateLabel(u"Agent Search", kPrimaryText, 2));
    title->SetFontList(
        title->font_list().DeriveWithWeight(gfx::Font::Weight::MEDIUM));

    empty_state_ = AddChildView(std::make_unique<views::View>());
    auto* empty_layout =
        empty_state_->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical, gfx::Insets::VH(34, 8),
            14));
    empty_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);
    root_layout->SetFlexForView(empty_state_, 1);

    auto* empty_badge = empty_state_->AddChildView(
        CreateLabel(u"✦", SkColorSetRGB(0x06, 0x17, 0x0E), 1));
    empty_badge->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    empty_badge->SetVerticalAlignment(gfx::ALIGN_MIDDLE);
    empty_badge->SetPreferredSize(gfx::Size(32, 32));
    empty_badge->SetBackground(views::CreateRoundedRectBackground(
        SkColorSetRGB(0x3D, 0xDC, 0x84), 16));

    auto* prompt = empty_state_->AddChildView(
        CreateLabel(u"How can I help you today?", kPrimaryText, 4));
    prompt->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    prompt->SetFontList(
        prompt->font_list().DeriveWithWeight(gfx::Font::Weight::MEDIUM));

    empty_state_->AddChildView(CreatePromptCard(
        u"Find flights under $600",
        base::BindRepeating(&AgentSearchSidePanelView::NavigateToGoogleSearch,
                            base::Unretained(this),
                            u"Find flights under $600")));
    empty_state_->AddChildView(CreatePromptCard(
        u"Summarize this article",
        base::BindRepeating(&AgentSearchSidePanelView::NavigateToGoogleSearch,
                            base::Unretained(this),
                            u"Summarize this article")));

    message_scroll_view_ =
        AddChildView(std::make_unique<views::ScrollView>());
    message_scroll_view_->SetHorizontalScrollBarMode(
        views::ScrollView::ScrollBarMode::kDisabled);
    message_scroll_view_->ClipHeightTo(0, std::numeric_limits<int>::max());
    message_scroll_view_->SetUseContentsPreferredSize(true);
    message_list_ =
        message_scroll_view_->SetContents(std::make_unique<views::View>());
    message_scroll_view_->RegisterPostLayoutCallback(base::BindRepeating(
        &AgentSearchSidePanelView::OnMessageScrollViewLayout,
        weak_ptr_factory_.GetWeakPtr()));
    auto* message_layout =
        message_list_->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical, gfx::Insets::VH(12, 0),
            10));
    message_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kStretch);
    message_scroll_view_->SetVisible(false);
    root_layout->SetFlexForView(message_scroll_view_, 1);

    auto* composer = AddChildView(std::make_unique<views::View>());
    constexpr SkColor kComposerBackground = SkColorSetRGB(0x2A, 0x2A, 0x2D);
    composer->SetBackground(
        views::CreateRoundedRectBackground(kComposerBackground, 24));
    auto* composer_layout =
        composer->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kHorizontal, gfx::Insets::VH(8, 14),
            8));

    input_ = composer->AddChildView(std::make_unique<views::Textfield>());
    input_->SetPlaceholderText(u"Ask Agent Search…");
    input_->SetBackgroundColor(kComposerBackground);
    input_->SetBorder(nullptr);
    input_->SetController(this);
    composer_layout->SetFlexForView(input_, 1);

    cancel_ = composer->AddChildView(std::make_unique<views::LabelButton>(
        base::BindRepeating(&AgentSearchSidePanelView::OnCancelPressed,
                            weak_ptr_factory_.GetWeakPtr()),
        u"Cancel"));
    cancel_->SetEnabledTextColors(kMutedText);
    cancel_->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(6, 8)));
    cancel_->SetVisible(false);

    send_ = composer->AddChildView(
        std::make_unique<views::ImageButton>(base::BindRepeating(
            &AgentSearchSidePanelView::OnSendPressed,
            weak_ptr_factory_.GetWeakPtr())));
    send_->SetPreferredSize(gfx::Size(28, 28));
    send_->SetImageHorizontalAlignment(views::ImageButton::ALIGN_CENTER);
    send_->SetImageVerticalAlignment(views::ImageButton::ALIGN_MIDDLE);
    send_->SetBorder(nullptr);
    send_->GetViewAccessibility().SetName(u"Send");
    UpdateSendButtonState();

    auto* trust = AddChildView(CreateLabel(
        u"Purchases always ask first", SkColorSetRGB(0x6A, 0x6A, 0x70), -2));
    trust->SetHorizontalAlignment(gfx::ALIGN_CENTER);

    RestoreChatHistory();
  }

  AgentSearchSidePanelView(const AgentSearchSidePanelView&) = delete;
  AgentSearchSidePanelView& operator=(const AgentSearchSidePanelView&) = delete;
  ~AgentSearchSidePanelView() override = default;

 private:
  void ContentsChanged(views::Textfield* sender,
                       const std::u16string& new_contents) override {
    if (sender == input_) {
      UpdateSendButtonState();
    }
  }

  bool HandleKeyEvent(views::Textfield* sender,
                      const ui::KeyEvent& key_event) override {
    if (sender == input_ && key_event.type() == ui::EventType::kKeyPressed &&
        key_event.key_code() == ui::VKEY_RETURN) {
      OnSendPressed();
      return true;
    }
    return false;
  }

  void OnSendPressed() {
    if (task_active_) {
      return;
    }
    std::u16string message(input_->GetText());
    base::TrimWhitespace(message, base::TRIM_ALL, &message);
    if (message.empty()) {
      return;
    }

    empty_state_->SetVisible(false);
    message_scroll_view_->SetVisible(true);
    AppendMessage(message, true, true);
    input_->SetText(std::u16string());
    run_has_assistant_message_ = false;
    SetTaskActive(true);
    ShowWorkingIndicator();

    StartAgentTask(message);
  }

  void OnCancelPressed() {
    if (!task_active_ || run_id_.empty()) {
      return;
    }
    cancel_->SetEnabled(false);
    bridge_loader_.reset();
    SendBridgeRequest(
        "POST", "/v1/tasks/" + run_id_ + "/cancel", std::nullopt,
        base::BindOnce(&AgentSearchSidePanelView::OnCancelSent,
                       weak_ptr_factory_.GetWeakPtr()));
  }

  void OnCancelSent(std::optional<base::DictValue> response) {
    if (!response || !response->FindBool("ok").value_or(false)) {
      const std::string* error =
          response ? response->FindString("error") : nullptr;
      AppendMessage(
          base::UTF8ToUTF16(
              error ? *error
                    : "The cancellation request could not be delivered."),
          false, true);
      cancel_->SetEnabled(true);
      return;
    }
    PollAgentEvents();
  }

  void AppendMessage(const std::u16string& text, bool from_user, bool persist) {
    const bool should_scroll_to_latest = IsNearBottom();
    auto label = CreateLabel(text, from_user ? kPrimaryText : kMutedText, 0);
    label->SetMultiLine(true);
    label->SetMaximumWidth(250);
    label->SetLineHeight(19);
    label->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(8, 10)));
    label->SetBackground(views::CreateRoundedRectBackground(
        from_user ? SkColorSetRGB(0x2A, 0x2A, 0x2D)
                  : SkColorSetRGB(0x23, 0x23, 0x26),
        10));
    message_list_->AddChildView(std::move(label));
    message_list_->InvalidateLayout();
    if (should_scroll_to_latest) {
      ScheduleScrollToLatestMessage();
    }
    if (persist) {
      PersistMessage(text, from_user);
    }
  }

  void ShowWorkingIndicator() {
    if (working_indicator_) {
      return;
    }
    const bool should_scroll_to_latest = IsNearBottom();
    auto indicator = std::make_unique<views::View>();
    indicator->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(8, 10)));
    indicator->SetBackground(views::CreateRoundedRectBackground(kSurface, 10));
    indicator->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 8));
    auto* throbber = indicator->AddChildView(std::make_unique<views::Throbber>());
    throbber->SetPreferredSize(gfx::Size(16, 16));
    throbber->Start();
    indicator->AddChildView(CreateLabel(u"Working…", kMutedText));
    working_indicator_ = message_list_->AddChildView(std::move(indicator));
    message_list_->InvalidateLayout();
    if (should_scroll_to_latest) {
      ScheduleScrollToLatestMessage();
    }
  }

  void RemoveWorkingIndicator() {
    if (!working_indicator_) {
      return;
    }
    // Clear the BackupRefPtr while the child is still alive. RemoveChildViewT()
    // returns an owning unique_ptr that is destroyed at the end of its full
    // expression; releasing working_indicator_ after that destruction is
    // diagnosed as a dangling raw_ptr release.
    views::View* indicator = working_indicator_;
    working_indicator_ = nullptr;
    message_list_->RemoveChildViewT(indicator);
    message_list_->InvalidateLayout();
  }

  void StartAgentTask(const std::u16string& task) {
    tabs::TabInterface* active_tab = browser_->GetActiveTabInterface();
    if (!active_tab) {
      RemoveWorkingIndicator();
      AppendMessage(u"No active browser tab is available.", false, true);
      SetTaskActive(false);
      return;
    }
    scoped_refptr<content::DevToolsAgentHost> agent_host =
        content::DevToolsAgentHost::GetOrCreateFor(active_tab->GetContents());
    base::DictValue request;
    request.Set("task", base::UTF16ToUTF8(task));
    request.Set("targetId", agent_host->GetId());
    SendBridgeRequest("POST", "/v1/tasks", std::move(request),
                      base::BindOnce(&AgentSearchSidePanelView::OnTaskStarted,
                                     weak_ptr_factory_.GetWeakPtr()));
  }

  using BridgeCallback =
      base::OnceCallback<void(std::optional<base::DictValue>)>;

  void SendBridgeRequest(std::string method,
                         std::string path,
                         std::optional<base::DictValue> body,
                         BridgeCallback callback) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(std::string(kAgentBridgeBaseUrl) + path);
    request->method = method;
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    static constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
        net::DefineNetworkTrafficAnnotation("agentsearch_agent_bridge", R"(
          semantics {
            sender: "AgentSearch native agent sidebar"
            description: "Sends an explicitly submitted agent task and reads its progress from the loopback-only AgentSearch bridge."
            trigger: "The user submits a task or answers a purchase confirmation."
            data: "Task text, a DevTools target identifier, and purchase decisions."
            destination: LOCAL
          }
          policy {
            cookies_allowed: NO
            setting: "This is initiated by the AgentSearch sidebar."
            policy_exception_justification: "The destination is a loopback companion process."
          })");
    bridge_loader_ = network::SimpleURLLoader::Create(std::move(request),
                                                      kTrafficAnnotation);
    bridge_loader_->SetAllowHttpErrorResults(true);
    if (body) {
      std::string json;
      base::JSONWriter::Write(*body, &json);
      bridge_loader_->AttachStringForUpload(json, "application/json");
    }
    bridge_loader_->DownloadToString(
        browser_->GetProfile()
            ->GetDefaultStoragePartition()
            ->GetURLLoaderFactoryForBrowserProcess()
            .get(),
        base::BindOnce(&AgentSearchSidePanelView::OnBridgeResponse,
                       weak_ptr_factory_.GetWeakPtr(), std::move(callback)),
        kMaxBridgeResponseBytes);
  }

  void OnBridgeResponse(BridgeCallback callback,
                        std::optional<std::string> response_body) {
    bridge_loader_.reset();
    if (!response_body) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    std::optional<base::Value> value =
        base::JSONReader::Read(*response_body, base::JSON_PARSE_RFC);
    if (!value || !value->is_dict()) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    std::move(callback).Run(std::move(*value).TakeDict());
  }

  void OnTaskStarted(std::optional<base::DictValue> response) {
    if (!response) {
      RemoveWorkingIndicator();
      AppendMessage(
          u"Agent bridge unavailable. Start it with `npm start` in "
          u"agent-bridge.",
          false, true);
      SetTaskActive(false);
      return;
    }
    const std::string* run_id = response->FindString("runId");
    if (!run_id) {
      RemoveWorkingIndicator();
      const std::string* error = response->FindString("error");
      AppendMessage(base::UTF8ToUTF16(error ? *error : "Bridge rejected task."),
                    false, true);
      SetTaskActive(false);
      return;
    }
    run_id_ = *run_id;
    last_event_sequence_ = 0;
    cancel_->SetVisible(true);
    cancel_->SetEnabled(true);
    PollAgentEvents();
  }

  void PollAgentEvents() {
    if (run_id_.empty() || bridge_loader_) {
      return;
    }
    SendBridgeRequest("GET",
                      "/v1/tasks/" + run_id_ + "/events?after=" +
                          base::NumberToString(last_event_sequence_),
                      std::nullopt,
                      base::BindOnce(&AgentSearchSidePanelView::OnAgentEvents,
                                     weak_ptr_factory_.GetWeakPtr()));
  }

  void OnAgentEvents(std::optional<base::DictValue> response) {
    if (!response) {
      RemoveWorkingIndicator();
      AppendMessage(u"Lost contact with the agent bridge.", false, true);
      FinishRun();
      return;
    }
    const base::ListValue* events = response->FindList("events");
    std::optional<std::u16string> terminal_message;
    if (events) {
      for (const base::Value& value : *events) {
        const base::DictValue* event = value.GetIfDict();
        if (!event) {
          continue;
        }
        last_event_sequence_ = std::max(last_event_sequence_,
                                        event->FindInt("sequence").value_or(0));
        const std::string* type = event->FindString("type");
        const std::string* text = event->FindString("text");
        if (!type || !text) {
          continue;
        }
        if (*type == "confirmation_required") {
          RemoveWorkingIndicator();
          const std::string* confirmation_id =
              event->FindString("confirmationId");
          if (confirmation_id) {
            AppendPurchaseConfirmation(base::UTF8ToUTF16(*text),
                                       *confirmation_id);
          }
        } else if (*type == "assistant_message") {
          AppendMessage(base::UTF8ToUTF16(*text), false, true);
          run_has_assistant_message_ = true;
        } else if (*type == "error" || *type == "cancelled") {
          terminal_message = base::UTF8ToUTF16(*text);
        }
      }
    }
    const std::string* status = response->FindString("status");
    if (!status) {
      RemoveWorkingIndicator();
      AppendMessage(u"The agent bridge returned an invalid task status.",
                    false, true);
      FinishRun();
    } else if (*status == "running") {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&AgentSearchSidePanelView::PollAgentEvents,
                         weak_ptr_factory_.GetWeakPtr()),
          base::Milliseconds(400));
    } else if (*status != "awaiting_confirmation") {
      RemoveWorkingIndicator();
      if (*status == "done" && !run_has_assistant_message_) {
        AppendMessage(
            u"Task did not complete as requested: no completion summary was "
            u"provided.",
            false, true);
      } else if (terminal_message) {
        AppendMessage(*terminal_message, false, true);
      } else if (*status == "denied") {
        AppendMessage(u"Action denied. Nothing was performed.", false, true);
      }
      FinishRun();
    }
  }

  void AppendPurchaseConfirmation(const std::u16string& summary,
                                  const std::string& confirmation_id) {
    const bool should_scroll_to_latest = IsNearBottom();
    auto card = std::make_unique<views::View>();
    card->SetBackground(views::CreateRoundedRectBackground(kSurface, 10));
    card->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(10, 10)));
    card->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical, gfx::Insets(), 8));
    auto* label = card->AddChildView(CreateLabel(summary, kPrimaryText));
    label->SetMultiLine(true);
    label->SetMaximumWidth(230);
    auto* buttons = card->AddChildView(std::make_unique<views::View>());
    buttons->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 8));
    auto* approve = buttons->AddChildView(CreatePromptCard(
        u"Approve", base::BindRepeating(
                        &AgentSearchSidePanelView::ResolvePurchaseConfirmation,
                        weak_ptr_factory_.GetWeakPtr(), confirmation_id, true)));
    auto* deny = buttons->AddChildView(CreatePromptCard(
        u"Deny", base::BindRepeating(
                     &AgentSearchSidePanelView::ResolvePurchaseConfirmation,
                     weak_ptr_factory_.GetWeakPtr(), confirmation_id, false)));
    approve->SetPreferredSize(gfx::Size(105, 38));
    deny->SetPreferredSize(gfx::Size(105, 38));
    confirmation_buttons_ = buttons;
    displayed_confirmation_id_ = confirmation_id;
    message_list_->AddChildView(std::move(card));
    message_list_->InvalidateLayout();
    if (should_scroll_to_latest) {
      ScheduleScrollToLatestMessage();
    }
    PersistMessage(summary, false);
  }

  void ResolvePurchaseConfirmation(std::string confirmation_id, bool approved) {
    if (run_id_.empty() || confirmation_id != displayed_confirmation_id_) {
      return;
    }
    if (confirmation_buttons_) {
      for (views::View* button : confirmation_buttons_->children()) {
        button->SetEnabled(false);
      }
    }
    base::DictValue request;
    request.Set("confirmationId", confirmation_id);
    request.Set("approved", approved);
    SendBridgeRequest(
        "POST", "/v1/tasks/" + run_id_ + "/confirmation", std::move(request),
        base::BindOnce(&AgentSearchSidePanelView::OnConfirmationSent,
                       weak_ptr_factory_.GetWeakPtr(), approved));
  }

  void OnConfirmationSent(bool approved,
                          std::optional<base::DictValue> response) {
    if (!response || !response->FindBool("ok").value_or(false)) {
      const std::string* error =
          response ? response->FindString("error") : nullptr;
      AppendMessage(
          base::UTF8ToUTF16(
              error ? *error : "The action decision could not be delivered."),
          false, true);
      PollAgentEvents();
      return;
    }
    displayed_confirmation_id_.clear();
    confirmation_buttons_ = nullptr;
    if (approved) {
      ShowWorkingIndicator();
    }
    PollAgentEvents();
  }

  void SetTaskActive(bool active) {
    task_active_ = active;
    input_->SetEnabled(!active);
    cancel_->SetVisible(active && !run_id_.empty());
    if (!active) {
      cancel_->SetEnabled(true);
    }
    UpdateSendButtonState();
  }

  void FinishRun() {
    run_id_.clear();
    displayed_confirmation_id_.clear();
    confirmation_buttons_ = nullptr;
    SetTaskActive(false);
  }

  void PersistMessage(const std::u16string& text, bool from_user) {
    PrefService* prefs = browser_->GetProfile()->GetPrefs();
    base::ListValue history =
        prefs->GetList(kAgentSearchChatHistoryPref).Clone();
    base::DictValue entry;
    entry.Set("role", from_user ? "user" : "agent");
    entry.Set("text", base::UTF16ToUTF8(text));
    entry.Set(
        "timestamp",
        static_cast<double>(base::Time::Now().InMillisecondsSinceUnixEpoch()));
    history.Append(std::move(entry));
    while (history.size() > 500u) {
      history.erase(history.begin());
    }
    prefs->SetList(kAgentSearchChatHistoryPref, std::move(history));
    LOG(INFO) << "AgentSearch chat history: wrote message; count="
              << prefs->GetList(kAgentSearchChatHistoryPref).size();
  }

  void RestoreChatHistory() {
    const base::ListValue& history =
        browser_->GetProfile()->GetPrefs()->GetList(
            kAgentSearchChatHistoryPref);
    if (history.empty()) {
      return;
    }
    empty_state_->SetVisible(false);
    message_scroll_view_->SetVisible(true);
    for (const base::Value& value : history) {
      const base::DictValue* entry = value.GetIfDict();
      if (!entry) {
        continue;
      }
      const std::string* text = entry->FindString("text");
      const std::string* role = entry->FindString("role");
      if (text && role) {
        AppendMessage(base::UTF8ToUTF16(*text), *role == "user", false);
      }
    }
  }

  void UpdateSendButtonState() {
    const bool has_input = input_ && !input_->GetText().empty() && !task_active_;
    const SkColor background = has_input ? SkColorSetRGB(0x3D, 0xDC, 0x84)
                                         : SkColorSetRGB(0x3A, 0x3A, 0x3E);
    const SkColor icon = has_input ? SkColorSetRGB(0x06, 0x17, 0x0E)
                                   : SkColorSetRGB(0x5A, 0x5A, 0x60);
    send_->SetBackground(views::CreateRoundedRectBackground(background, 14));
    send_->SetImageModel(
        views::Button::STATE_NORMAL,
        ui::ImageModel::FromVectorIcon(kArrowUpwardIcon, icon, 15));
    send_->SetImageModel(
        views::Button::STATE_DISABLED,
        ui::ImageModel::FromVectorIcon(kArrowUpwardIcon, icon, 15));
    send_->SetEnabled(has_input);
    send_->SchedulePaint();
  }

  void ScheduleScrollToLatestMessage() {
    scroll_to_latest_pending_ = true;
    message_scroll_view_->InvalidateLayout();
  }

  bool IsNearBottom() const {
    if (!message_scroll_view_ || !message_list_ ||
        message_list_->children().empty()) {
      return true;
    }
    const gfx::Rect visible_rect = message_scroll_view_->GetVisibleRect();
    return visible_rect.bottom() >=
           message_list_->height() - kAutoScrollTolerance;
  }

  void OnMessageScrollViewLayout(views::ScrollView* scroll_view) {
    if (scroll_to_latest_pending_ && scroll_view->GetVisible() &&
        !message_list_->children().empty()) {
      scroll_to_latest_pending_ = false;
      message_list_->children().back()->ScrollViewToVisible();
    }
  }

  void NavigateToGoogleSearch(std::u16string query) {
    base::TrimWhitespace(query, base::TRIM_ALL, &query);
    if (query.empty()) {
      return;
    }

    tabs::TabInterface* active_tab = browser_->GetActiveTabInterface();
    if (!active_tab) {
      return;
    }

    const std::string escaped_query =
        base::EscapeQueryParamValue(base::UTF16ToUTF8(query), true);
    content::NavigationController::LoadURLParams params(GURL(
        "https://www.google.com/search?q=" + escaped_query));
    params.transition_type = ui::PAGE_TRANSITION_GENERATED;
    active_tab->GetContents()->GetController().LoadURLWithParams(params);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<views::View> empty_state_ = nullptr;
  raw_ptr<views::ScrollView> message_scroll_view_ = nullptr;
  raw_ptr<views::View> message_list_ = nullptr;
  raw_ptr<views::Textfield> input_ = nullptr;
  raw_ptr<views::LabelButton> cancel_ = nullptr;
  raw_ptr<views::ImageButton> send_ = nullptr;
  raw_ptr<views::View> confirmation_buttons_ = nullptr;
  raw_ptr<views::View> working_indicator_ = nullptr;
  std::unique_ptr<network::SimpleURLLoader> bridge_loader_;
  std::string run_id_;
  std::string displayed_confirmation_id_;
  int last_event_sequence_ = 0;
  bool task_active_ = false;
  bool run_has_assistant_message_ = false;
  bool scroll_to_latest_pending_ = false;
  base::WeakPtrFactory<AgentSearchSidePanelView> weak_ptr_factory_{this};
};

}  // namespace

SidePanelNativeView CreateAgentSearchSidePanelView(SidePanelEntryScope& scope) {
  return std::make_unique<AgentSearchSidePanelView>(
      &scope.GetBrowserWindowInterface());
}
