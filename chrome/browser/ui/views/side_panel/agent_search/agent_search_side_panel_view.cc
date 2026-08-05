// Copyright 2026 The AgentSearch Authors

#include "chrome/browser/ui/views/side_panel/agent_search/agent_search_side_panel_view.h"

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
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/controls/textfield/textfield_controller.h"
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
        base::BindRepeating(&AgentSearchSidePanelView::NavigateToSearchResults,
                            base::Unretained(this),
                            u"Find flights under $600")));
    empty_state_->AddChildView(CreatePromptCard(
        u"Summarize this article",
        base::BindRepeating(&AgentSearchSidePanelView::NavigateToSearchResults,
                            base::Unretained(this),
                            u"Summarize this article")));

    message_list_ = AddChildView(std::make_unique<views::View>());
    auto* message_layout =
        message_list_->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical, gfx::Insets::VH(12, 0),
            10));
    message_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kStretch);
    message_list_->SetVisible(false);
    root_layout->SetFlexForView(message_list_, 1);

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

    send_ = composer->AddChildView(
        std::make_unique<views::ImageButton>(base::BindRepeating(
            &AgentSearchSidePanelView::OnSendPressed, base::Unretained(this))));
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
    std::u16string message(input_->GetText());
    base::TrimWhitespace(message, base::TRIM_ALL, &message);
    if (message.empty()) {
      return;
    }

    empty_state_->SetVisible(false);
    message_list_->SetVisible(true);
    AppendMessage(message, true, true);
    input_->SetText(std::u16string());
    UpdateSendButtonState();

    StartAgentTask(message);
  }

  void AppendMessage(const std::u16string& text, bool from_user, bool persist) {
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
    if (persist) {
      PersistMessage(text, from_user);
    }
  }

  void StartAgentTask(const std::u16string& task) {
    tabs::TabInterface* active_tab = browser_->GetActiveTabInterface();
    if (!active_tab) {
      AppendMessage(u"No active browser tab is available.", false, true);
      return;
    }
    scoped_refptr<content::DevToolsAgentHost> agent_host =
        content::DevToolsAgentHost::GetOrCreateForTab(
            active_tab->GetContents());
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
      AppendMessage(
          u"Agent bridge unavailable. Start it with `npm start` in "
          u"agent-bridge.",
          false, true);
      return;
    }
    const std::string* run_id = response->FindString("runId");
    if (!run_id) {
      const std::string* error = response->FindString("error");
      AppendMessage(base::UTF8ToUTF16(error ? *error : "Bridge rejected task."),
                    false, true);
      return;
    }
    run_id_ = *run_id;
    last_event_sequence_ = 0;
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
      AppendMessage(u"Lost contact with the agent bridge.", false, true);
      run_id_.clear();
      return;
    }
    const base::ListValue* events = response->FindList("events");
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
          const std::string* confirmation_id =
              event->FindString("confirmationId");
          if (confirmation_id) {
            AppendPurchaseConfirmation(base::UTF8ToUTF16(*text),
                                       *confirmation_id);
          }
        } else {
          AppendMessage(base::UTF8ToUTF16(*text), false,
                        event->FindBool("persist").value_or(false));
        }
      }
    }
    const std::string* status = response->FindString("status");
    if (status && *status == "running") {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&AgentSearchSidePanelView::PollAgentEvents,
                         weak_ptr_factory_.GetWeakPtr()),
          base::Milliseconds(400));
    } else {
      run_id_.clear();
    }
  }

  void AppendPurchaseConfirmation(const std::u16string& summary,
                                  const std::string& confirmation_id) {
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
                        base::Unretained(this), confirmation_id, true)));
    auto* deny = buttons->AddChildView(CreatePromptCard(
        u"Deny", base::BindRepeating(
                     &AgentSearchSidePanelView::ResolvePurchaseConfirmation,
                     base::Unretained(this), confirmation_id, false)));
    approve->SetPreferredSize(gfx::Size(105, 38));
    deny->SetPreferredSize(gfx::Size(105, 38));
    confirmation_buttons_ = buttons;
    displayed_confirmation_id_ = confirmation_id;
    message_list_->AddChildView(std::move(card));
    message_list_->InvalidateLayout();
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
      AppendMessage(u"The purchase decision could not be delivered.", false,
                    true);
      return;
    }
    displayed_confirmation_id_.clear();
    confirmation_buttons_ = nullptr;
    PollAgentEvents();
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
    message_list_->SetVisible(true);
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
    const bool has_input = input_ && !input_->GetText().empty();
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

  void NavigateToSearchResults(std::u16string query) {
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
        "chrome://new-tab-page/agentsearch_results.html?q=" + escaped_query));
    params.transition_type = ui::PAGE_TRANSITION_GENERATED;
    active_tab->GetContents()->GetController().LoadURLWithParams(params);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<views::View> empty_state_ = nullptr;
  raw_ptr<views::View> message_list_ = nullptr;
  raw_ptr<views::Textfield> input_ = nullptr;
  raw_ptr<views::ImageButton> send_ = nullptr;
  raw_ptr<views::View> confirmation_buttons_ = nullptr;
  std::unique_ptr<network::SimpleURLLoader> bridge_loader_;
  std::string run_id_;
  std::string displayed_confirmation_id_;
  int last_event_sequence_ = 0;
  base::WeakPtrFactory<AgentSearchSidePanelView> weak_ptr_factory_{this};
};

}  // namespace

SidePanelNativeView CreateAgentSearchSidePanelView(SidePanelEntryScope& scope) {
  return std::make_unique<AgentSearchSidePanelView>(
      &scope.GetBrowserWindowInterface());
}
