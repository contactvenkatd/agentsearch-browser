// Copyright 2026 The AgentSearch Authors

#include "chrome/browser/ui/views/side_panel/agent_search/agent_search_side_panel_view.h"

#include <memory>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/escape.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/app/vector_icons/vector_icons.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_scope.h"
#include "chrome/browser/profiles/profile.h"
#include "components/prefs/pref_service.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/models/image_model.h"
#include "ui/base/page_transition_types.h"
#include "ui/color/color_provider.h"
#include "ui/events/event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/color_palette.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/views/background.h"
#include "ui/views/accessibility/view_accessibility.h"
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
constexpr char16_t kSimulatedResponse[] =
    u"This is a simulated response — the real agent isn't connected yet.";
constexpr char kAgentSearchChatHistoryPref[] = "agentsearch.chat_history";

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
  auto button = std::make_unique<views::LabelButton>(
      std::move(callback), text);
  button->SetHorizontalAlignment(gfx::ALIGN_LEFT);
  button->SetEnabledTextColors(kMutedText);
  button->SetBackground(views::CreateRoundedRectBackground(kSurface, 10));
  button->SetBorder(
      views::CreateEmptyBorder(gfx::Insets::VH(12, 14)));
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
    auto* root_layout =
        SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical,
            gfx::Insets(), 14));

    auto* header = AddChildView(std::make_unique<views::View>());
    header->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 9));

    auto* badge = header->AddChildView(CreateLabel(
        u"✦", SkColorSetRGB(0x06, 0x17, 0x0E), 0));
    badge->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    badge->SetVerticalAlignment(gfx::ALIGN_MIDDLE);
    badge->SetPreferredSize(gfx::Size(24, 24));
    badge->SetBackground(views::CreateRoundedRectBackground(
        SkColorSetRGB(0x3D, 0xDC, 0x84), 12));

    auto* header_text = header->AddChildView(std::make_unique<views::View>());
    header_text->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical, gfx::Insets(), 0));
    auto* title =
        header_text->AddChildView(CreateLabel(u"Agent Search", kPrimaryText, 2));
    title->SetFontList(title->font_list().DeriveWithWeight(
        gfx::Font::Weight::MEDIUM));

    empty_state_ = AddChildView(std::make_unique<views::View>());
    auto* empty_layout =
        empty_state_->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical,
            gfx::Insets::VH(34, 8), 14));
    empty_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);
    root_layout->SetFlexForView(empty_state_, 1);

    auto* empty_badge =
        empty_state_->AddChildView(CreateLabel(
            u"✦", SkColorSetRGB(0x06, 0x17, 0x0E), 1));
    empty_badge->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    empty_badge->SetVerticalAlignment(gfx::ALIGN_MIDDLE);
    empty_badge->SetPreferredSize(gfx::Size(32, 32));
    empty_badge->SetBackground(views::CreateRoundedRectBackground(
        SkColorSetRGB(0x3D, 0xDC, 0x84), 16));

    auto* prompt = empty_state_->AddChildView(CreateLabel(
        u"How can I help you today?", kPrimaryText, 4));
    prompt->SetHorizontalAlignment(gfx::ALIGN_CENTER);
    prompt->SetFontList(prompt->font_list().DeriveWithWeight(
        gfx::Font::Weight::MEDIUM));

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
            views::BoxLayout::Orientation::kVertical,
            gfx::Insets::VH(12, 0), 10));
    message_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kStretch);
    message_list_->SetVisible(false);
    root_layout->SetFlexForView(message_list_, 1);

    auto* composer = AddChildView(std::make_unique<views::View>());
    constexpr SkColor kComposerBackground =
        SkColorSetRGB(0x2A, 0x2A, 0x2D);
    composer->SetBackground(
        views::CreateRoundedRectBackground(kComposerBackground, 24));
    auto* composer_layout =
        composer->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal,
        gfx::Insets::VH(8, 14), 8));

    input_ = composer->AddChildView(std::make_unique<views::Textfield>());
    input_->SetPlaceholderText(u"Ask Agent Search…");
    input_->SetBackgroundColor(kComposerBackground);
    input_->SetBorder(nullptr);
    input_->SetController(this);
    composer_layout->SetFlexForView(input_, 1);

    send_ = composer->AddChildView(
        std::make_unique<views::ImageButton>(
            base::BindRepeating(&AgentSearchSidePanelView::OnSendPressed,
                                base::Unretained(this))));
    send_->SetPreferredSize(gfx::Size(28, 28));
    send_->SetImageHorizontalAlignment(views::ImageButton::ALIGN_CENTER);
    send_->SetImageVerticalAlignment(views::ImageButton::ALIGN_MIDDLE);
    send_->SetBorder(nullptr);
    send_->GetViewAccessibility().SetName(u"Send");
    UpdateSendButtonState();

    auto* trust = AddChildView(CreateLabel(
        u"Purchases always ask first", SkColorSetRGB(0x6A, 0x6A, 0x70),
        -2));
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

    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&AgentSearchSidePanelView::AppendSimulatedResponse,
                       weak_ptr_factory_.GetWeakPtr()),
        base::Milliseconds(500));
  }

  void AppendMessage(const std::u16string& text,
                     bool from_user,
                     bool persist) {
    auto label = CreateLabel(
        text, from_user ? kPrimaryText : kMutedText, 0);
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

  void AppendSimulatedResponse() {
    AppendMessage(kSimulatedResponse, false, true);
  }

  void PersistMessage(const std::u16string& text, bool from_user) {
    PrefService* prefs = browser_->GetProfile()->GetPrefs();
    base::ListValue history =
        prefs->GetList(kAgentSearchChatHistoryPref).Clone();
    base::DictValue entry;
    entry.Set("role", from_user ? "user" : "agent");
    entry.Set("text", base::UTF16ToUTF8(text));
    entry.Set("timestamp", static_cast<double>(
                               base::Time::Now().InMillisecondsSinceUnixEpoch()));
    history.Append(std::move(entry));
    while (history.size() > 500u) {
      history.erase(history.begin());
    }
    prefs->SetList(kAgentSearchChatHistoryPref, std::move(history));
    LOG(INFO) << "AgentSearch chat history: wrote message; count="
              << prefs->GetList(kAgentSearchChatHistoryPref).size();
  }

  void RestoreChatHistory() {
    const base::ListValue& history = browser_->GetProfile()->GetPrefs()->GetList(
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
    const SkColor background =
        has_input ? SkColorSetRGB(0x3D, 0xDC, 0x84)
                  : SkColorSetRGB(0x3A, 0x3A, 0x3E);
    const SkColor icon =
        has_input ? SkColorSetRGB(0x06, 0x17, 0x0E)
                  : SkColorSetRGB(0x5A, 0x5A, 0x60);
    send_->SetBackground(views::CreateRoundedRectBackground(background, 14));
    send_->SetImageModel(views::Button::STATE_NORMAL,
                         ui::ImageModel::FromVectorIcon(
                             kArrowUpwardIcon, icon, 15));
    send_->SetImageModel(views::Button::STATE_DISABLED,
                         ui::ImageModel::FromVectorIcon(
                             kArrowUpwardIcon, icon, 15));
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
    content::NavigationController::LoadURLParams params(
        GURL("chrome://new-tab-page/agentsearch_results.html?q=" +
             escaped_query));
    params.transition_type = ui::PAGE_TRANSITION_GENERATED;
    active_tab->GetContents()->GetController().LoadURLWithParams(params);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<views::View> empty_state_ = nullptr;
  raw_ptr<views::View> message_list_ = nullptr;
  raw_ptr<views::Textfield> input_ = nullptr;
  raw_ptr<views::ImageButton> send_ = nullptr;
  base::WeakPtrFactory<AgentSearchSidePanelView> weak_ptr_factory_{this};
};

}  // namespace

SidePanelNativeView CreateAgentSearchSidePanelView(
    SidePanelEntryScope& scope) {
  return std::make_unique<AgentSearchSidePanelView>(
      &scope.GetBrowserWindowInterface());
}
